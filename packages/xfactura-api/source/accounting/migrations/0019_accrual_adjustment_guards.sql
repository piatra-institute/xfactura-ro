-- Drizzle custom migration: immutable estimate changes and state-bound accrual consumption.
-- Ordinary table/index/foreign-key definitions are generated in 0018.
CREATE TRIGGER acc_guard_accrual_adjustment BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.accrualAdjustment')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_accrual_postings ap ON ap.company_id=p.company_id AND ap.accrual_id=json_extract(p.body,'$.accrualAdjustment.accrualId')
    JOIN acc_proposals original ON original.company_id=ap.company_id AND original.id=ap.accrual_id
    JOIN acc_journals j ON j.company_id=ap.company_id AND j.id=ap.journal_id
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=NEW.evidence_id
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice') IS NULL AND json_type(p.body,'$.settlement') IS NULL
      AND json_type(p.body,'$.accrual') IS NULL AND json_type(p.body,'$.unbilledSale') IS NULL
      AND json_extract(p.body,'$.purpose')='adjustment'
      AND json_extract(p.body,'$.accrualAdjustment.periodBasis')='current_year_estimate_change'
      AND json_extract(original.body,'$.financialYearId')=json_extract(p.body,'$.financialYearId')
      AND j.id=json_extract(p.body,'$.accrualAdjustment.originalJournalId')
      AND original.hash=json_extract(p.body,'$.accrualAdjustment.originalProposalHash')
      AND json_extract(original.body,'$.financialYearId')=json_extract(p.body,'$.accrualAdjustment.originalFinancialYearId')
      AND json_extract(p.body,'$.accrualAdjustment.date')=NEW.date
      AND json_extract(p.body,'$.accrualAdjustment.evidenceId')=NEW.evidence_id
      AND json_extract(p.body,'$.accrualAdjustment.sourceHash')=e.hash
      AND json_extract(p.body,'$.sourceReference')='accrual-adjustment:'||json_extract(p.body,'$.accrualAdjustment.reference')
      AND json_extract(p.body,'$.accrualAdjustment.evidenceDate')<=json_extract(p.body,'$.accrualAdjustment.newInformationDate')
      AND json_extract(p.body,'$.accrualAdjustment.newInformationDate') BETWEEN j.date AND NEW.date
      AND substr(json_extract(p.body,'$.accrualAdjustment.newInformationDate'),1,7)=substr(NEW.date,1,7)
      AND json_extract(p.body,'$.accrualAdjustment.previousJournalId')=coalesce((SELECT a.journal_id FROM acc_accrual_adjustments a JOIN acc_journals aj ON aj.company_id=a.company_id AND aj.id=a.journal_id WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id ORDER BY aj.number DESC LIMIT 1),j.id)
      AND json_extract(p.body,'$.correctsJournalId')=json_extract(p.body,'$.accrualAdjustment.previousJournalId')
      AND json_extract(p.body,'$.accrualAdjustment.positionVersion')=(SELECT count(*) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id)+(SELECT count(*) FROM acc_accrual_adjustments a WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id)
      AND NOT EXISTS(SELECT 1 FROM acc_accrual_adjustments a JOIN acc_journals aj ON aj.company_id=a.company_id AND aj.id=a.journal_id WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id AND aj.date>NEW.date)
      AND NOT EXISTS(SELECT 1 FROM acc_accrual_matches m JOIN acc_invoice_postings ip ON ip.company_id=m.company_id AND ip.invoice_id=m.invoice_id JOIN acc_journals mj ON mj.company_id=ip.company_id AND mj.id=ip.journal_id WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id AND mj.date>NEW.date)
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.previousRemaining.net'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.accrual.net'),'.','') AS INTEGER)+coalesce((SELECT sum(a.net_bani) FROM acc_accrual_adjustments a WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id),0)-coalesce((SELECT sum(m.net_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.previousRemaining.tax'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.accrual.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(a.tax_bani) FROM acc_accrual_adjustments a WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id),0)-coalesce((SELECT sum(m.tax_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.previousRemaining.gross'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.accrual.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(a.gross_bani) FROM acc_accrual_adjustments a WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id),0)-coalesce((SELECT sum(m.gross_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.previousRemaining.deferredTax'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.accrual.deferredTax'),'.','') AS INTEGER)+coalesce((SELECT sum(a.deferred_tax_bani) FROM acc_accrual_adjustments a WHERE a.company_id=p.company_id AND a.accrual_id=ap.accrual_id),0)-coalesce((SELECT sum(m.deductible_tax_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.previousRemaining.gross'),'.','') AS INTEGER)>0
      AND json_extract(p.body,'$.accrualAdjustment.remainingNet')=json_extract(p.body,'$.accrualAdjustment.remaining.net')
      AND ((json_extract(p.body,'$.accrualAdjustment.action')='release' AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.remaining.net'),'.','') AS INTEGER)=0) OR (json_extract(p.body,'$.accrualAdjustment.action')='reestimate' AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.remaining.net'),'.','') AS INTEGER)>0))
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.accrualAdjustment.remaining') r WHERE CAST(replace(r.value,'.','') AS INTEGER)<0)
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.accrualAdjustment.delta') d WHERE CAST(replace(d.value,'.','') AS INTEGER)<>CAST(replace(json_extract(p.body,'$.accrualAdjustment.remaining.'||d.key),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.accrualAdjustment.previousRemaining.'||d.key),'.','') AS INTEGER))
      AND NEW.lines_json=(SELECT json_group_array(json_object('account',account,'debitBani',CAST(max(amount,0) AS TEXT),'creditBani',CAST(max(-amount,0) AS TEXT))) FROM (
        SELECT 1 AS ordinal,json_extract(original.body,'$.accrual.account') AS account,CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.deferredTax'),'.','') AS INTEGER) AS amount
        UNION ALL SELECT 2,'408',-CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.gross'),'.','') AS INTEGER)
        UNION ALL SELECT 3,'4428',CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.deferredTax'),'.','') AS INTEGER)
      ) WHERE amount<>0 ORDER BY ordinal)
  ) THEN RAISE(ABORT,'stale_or_invalid_accrual_adjustment') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_adjustment_insert BEFORE INSERT ON acc_accrual_adjustments BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general' AND p.id=NEW.proposal_id
      AND json_extract(p.body,'$.accrualAdjustment.accrualId')=NEW.accrual_id
      AND json_extract(p.body,'$.accrualAdjustment.reference')=NEW.reference
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.net'),'.','') AS INTEGER)=NEW.net_bani
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.tax'),'.','') AS INTEGER)=NEW.tax_bani
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.gross'),'.','') AS INTEGER)=NEW.gross_bani
      AND CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.deferredTax'),'.','') AS INTEGER)=NEW.deferred_tax_bani
      AND j.created_by=NEW.created_by AND j.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_accrual_adjustment_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_accrual_adjustment AFTER INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_accrual_adjustments(company_id,proposal_id,accrual_id,journal_id,reference,net_bani,tax_bani,gross_bani,deferred_tax_bani,created_by,created_at)
  SELECT NEW.company_id,p.id,json_extract(p.body,'$.accrualAdjustment.accrualId'),NEW.id,json_extract(p.body,'$.accrualAdjustment.reference'),
    CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.net'),'.','') AS INTEGER),
    CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.tax'),'.','') AS INTEGER),
    CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.gross'),'.','') AS INTEGER),
    CAST(replace(json_extract(p.body,'$.accrualAdjustment.delta.deferredTax'),'.','') AS INTEGER),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.accrualAdjustment')='object';
END;
--> statement-breakpoint
DROP TRIGGER acc_guard_accrual_match;
--> statement-breakpoint
CREATE TRIGGER acc_guard_accrual_match BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.accrualMatch')='object'
      AND (json_type(p.body,'$.invoice.credit') IS NOT NULL OR json_type(p.body,'$.invoice.unbilledSaleMatch') IS NOT NULL
        OR json_type(p.body,'$.accrual') IS NOT NULL OR json_type(p.body,'$.settlement') IS NOT NULL
        OR json_type(p.body,'$.unbilledSale') IS NOT NULL OR json_type(p.body,'$.accrualAdjustment') IS NOT NULL
        OR json_extract(p.body,'$.purpose')<>'purchase' OR json_extract(p.body,'$.invoice.direction')<>'purchase')
  ) THEN RAISE(ABORT,'invalid_accrual_match_origin') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p JOIN json_each(p.body,'$.invoice.accrualMatch.allocations') a
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND NOT EXISTS (
      SELECT 1 FROM acc_accrual_postings ap JOIN acc_proposals original ON original.company_id=ap.company_id AND original.id=ap.accrual_id
      JOIN acc_journals j ON j.company_id=ap.company_id AND j.id=ap.journal_id
      WHERE ap.company_id=p.company_id AND ap.accrual_id=json_extract(a.value,'$.accrualId')
        AND j.id=json_extract(a.value,'$.originalJournalId') AND j.date<=NEW.date AND original.hash=json_extract(a.value,'$.proposalHash')
        AND json_extract(original.body,'$.financialYearId')=json_extract(a.value,'$.originalFinancialYearId')
        AND json_extract(a.value,'$.positionVersion')=(SELECT count(*) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id)+(SELECT count(*) FROM acc_accrual_adjustments d WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id)
        AND NOT EXISTS(SELECT 1 FROM acc_accrual_adjustments d JOIN acc_journals dj ON dj.company_id=d.company_id AND dj.id=d.journal_id WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id AND dj.date>NEW.date)
        AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)>0
        AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)+coalesce((SELECT sum(m.net_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)<=CAST(replace(json_extract(original.body,'$.accrual.net'),'.','') AS INTEGER)+coalesce((SELECT sum(d.net_bani) FROM acc_accrual_adjustments d WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id),0)
        AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(m.tax_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)<=CAST(replace(json_extract(original.body,'$.accrual.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(d.tax_bani) FROM acc_accrual_adjustments d WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id),0)
        AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(m.gross_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)<=CAST(replace(json_extract(original.body,'$.accrual.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(d.gross_bani) FROM acc_accrual_adjustments d WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id),0)
        AND CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.accrual.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(d.gross_bani) FROM acc_accrual_adjustments d WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id),0)-coalesce((SELECT sum(m.gross_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)
        AND CAST(replace(json_extract(a.value,'$.remainingGross'),'.','') AS INTEGER)=CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)-CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.deductibleTax'),'.','') AS INTEGER)+coalesce((SELECT sum(m.deductible_tax_bani) FROM acc_accrual_matches m WHERE m.company_id=p.company_id AND m.accrual_id=ap.accrual_id),0)<=CAST(replace(json_extract(original.body,'$.accrual.deferredTax'),'.','') AS INTEGER)+coalesce((SELECT sum(d.deferred_tax_bani) FROM acc_accrual_adjustments d WHERE d.company_id=p.company_id AND d.accrual_id=ap.accrual_id),0)
    )
  ) THEN RAISE(ABORT,'stale_or_excessive_accrual_match') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_adjustment_update BEFORE UPDATE ON acc_accrual_adjustments BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_accrual_adjustment_delete BEFORE DELETE ON acc_accrual_adjustments BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
