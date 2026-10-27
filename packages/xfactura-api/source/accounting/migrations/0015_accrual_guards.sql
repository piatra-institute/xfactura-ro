-- Drizzle custom migration: immutable accrual projections and exact invoice consumption.
-- Ordinary table/index/foreign-key definitions are generated in 0014.
CREATE TRIGGER acc_guard_accrual_origin BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.accrual')='object'
      AND (json_type(p.body,'$.invoice') IS NOT NULL
        OR json_type(p.body,'$.settlement') IS NOT NULL
        OR json_extract(p.body,'$.purpose')<>'purchase'
        OR json_extract(p.body,'$.accrual.date')<>NEW.date
        OR json_extract(p.body,'$.accrual.evidenceId')<>NEW.evidence_id)
  ) THEN RAISE(ABORT,'invalid_accrual_origin') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_projection_insert BEFORE INSERT ON acc_accrual_postings BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_journals j JOIN acc_proposals p
      ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id
      AND j.kind='general' AND p.id=NEW.accrual_id
      AND json_extract(p.body,'$.accrual.reference')=NEW.reference
  ) THEN RAISE(ABORT,'invalid_accrual_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_accrual AFTER INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_accrual_postings(company_id,accrual_id,journal_id,reference,created_by,created_at)
  SELECT NEW.company_id,p.id,NEW.id,json_extract(p.body,'$.accrual.reference'),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
    AND json_type(p.body,'$.accrual')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_accrual_match BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.accrualMatch')='object'
      AND (json_type(p.body,'$.invoice.credit') IS NOT NULL
        OR json_type(p.body,'$.accrual') IS NOT NULL
        OR json_type(p.body,'$.settlement') IS NOT NULL
        OR json_extract(p.body,'$.purpose')<>'purchase'
        OR json_extract(p.body,'$.invoice.direction')<>'purchase')
  ) THEN RAISE(ABORT,'invalid_accrual_match_origin') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p JOIN json_each(p.body,'$.invoice.accrualMatch.allocations') a
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND NOT EXISTS (
        SELECT 1 FROM acc_accrual_postings ap
        JOIN acc_proposals original ON original.company_id=ap.company_id AND original.id=ap.accrual_id
        JOIN acc_journals j ON j.company_id=ap.company_id AND j.id=ap.journal_id
        WHERE ap.company_id=p.company_id AND ap.accrual_id=json_extract(a.value,'$.accrualId')
          AND j.id=json_extract(a.value,'$.originalJournalId') AND j.date<=NEW.date
          AND original.hash=json_extract(a.value,'$.proposalHash')
          AND json_extract(original.body,'$.financialYearId')=json_extract(a.value,'$.originalFinancialYearId')
          AND json_extract(a.value,'$.positionVersion')=(SELECT count(*) FROM acc_accrual_matches m
            WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id)
          AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)>0
          AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)
            +coalesce((SELECT sum(m.net_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
            <=CAST(replace(json_extract(original.body,'$.accrual.net'),'.','') AS INTEGER)
          AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)
            +coalesce((SELECT sum(m.tax_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
            <=CAST(replace(json_extract(original.body,'$.accrual.tax'),'.','') AS INTEGER)
          AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
            +coalesce((SELECT sum(m.gross_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
            <=CAST(replace(json_extract(original.body,'$.accrual.gross'),'.','') AS INTEGER)
          AND CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)
            =CAST(replace(json_extract(original.body,'$.accrual.gross'),'.','') AS INTEGER)
            -coalesce((SELECT sum(m.gross_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
          AND CAST(replace(json_extract(a.value,'$.remainingGross'),'.','') AS INTEGER)
            =CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)
            -CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
          AND CAST(replace(json_extract(a.value,'$.deductibleTax'),'.','') AS INTEGER)
            +coalesce((SELECT sum(m.deductible_tax_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
            <=CAST(replace(json_extract(original.body,'$.accrual.deferredTax'),'.','') AS INTEGER)
      )
  ) THEN RAISE(ABORT,'stale_or_excessive_accrual_match') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_match_insert BEFORE INSERT ON acc_accrual_matches BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_invoice_postings ip JOIN acc_proposals p
      ON p.company_id=ip.company_id AND p.id=ip.proposal_id
    JOIN json_each(p.body,'$.invoice.accrualMatch.allocations') a
    WHERE ip.company_id=NEW.company_id AND ip.invoice_id=NEW.invoice_id
      AND json_extract(a.value,'$.accrualId')=NEW.accrual_id
      AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)=NEW.net_bani
      AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)=NEW.tax_bani
      AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)=NEW.gross_bani
      AND CAST(replace(json_extract(a.value,'$.deductibleTax'),'.','') AS INTEGER)=NEW.deductible_tax_bani
  ) THEN RAISE(ABORT,'invalid_accrual_match_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_accrual_matches AFTER INSERT ON acc_invoice_postings BEGIN
  INSERT INTO acc_accrual_matches(company_id,invoice_id,accrual_id,net_bani,tax_bani,gross_bani,deductible_tax_bani)
  SELECT NEW.company_id,NEW.invoice_id,json_extract(a.value,'$.accrualId'),
    CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER),
    CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER),
    CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER),
    CAST(replace(json_extract(a.value,'$.deductibleTax'),'.','') AS INTEGER)
  FROM acc_proposals p JOIN json_each(p.body,'$.invoice.accrualMatch.allocations') a
  WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id;
END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_posting_update BEFORE UPDATE ON acc_accrual_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_posting_delete BEFORE DELETE ON acc_accrual_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_match_update BEFORE UPDATE ON acc_accrual_matches BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_match_delete BEFORE DELETE ON acc_accrual_matches BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
