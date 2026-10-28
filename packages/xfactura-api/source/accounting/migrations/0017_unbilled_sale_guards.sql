-- Drizzle custom migration: immutable unbilled sales and exact later-invoice consumption.
-- Table/index/foreign-key definitions are generated in 0016.
CREATE TRIGGER acc_guard_general_origins BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND ((CASE WHEN json_type(p.body,'$.invoice')='object' THEN 1 ELSE 0 END)
        +(CASE WHEN json_type(p.body,'$.settlement')='object' THEN 1 ELSE 0 END)
        +(CASE WHEN json_type(p.body,'$.accrual')='object' THEN 1 ELSE 0 END)
        +(CASE WHEN json_type(p.body,'$.unbilledSale')='object' THEN 1 ELSE 0 END)>1
        OR (CASE WHEN json_type(p.body,'$.invoice.credit')='object' THEN 1 ELSE 0 END)
          +(CASE WHEN json_type(p.body,'$.invoice.accrualMatch')='object' THEN 1 ELSE 0 END)
          +(CASE WHEN json_type(p.body,'$.invoice.unbilledSaleMatch')='object' THEN 1 ELSE 0 END)>1)
  ) THEN RAISE(ABORT,'multiple_general_origins') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_unbilled_sale BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.unbilledSale')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=NEW.evidence_id
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.purpose')='sale'
      AND json_extract(p.body,'$.correctsJournalId') IS NULL
      AND json_extract(p.body,'$.unbilledSale.date')=NEW.date
      AND json_extract(p.body,'$.unbilledSale.serviceTo')=NEW.date
      AND json_extract(p.body,'$.unbilledSale.taxPointDate')=NEW.date
      AND json_extract(p.body,'$.unbilledSale.evidenceId')=NEW.evidence_id
      AND json_extract(p.body,'$.unbilledSale.sourceHash')=e.hash
      AND json_extract(p.body,'$.sourceReference')='unbilled-sale:'||json_extract(p.body,'$.unbilledSale.reference')
      AND NEW.lines_json=CASE WHEN CAST(replace(json_extract(p.body,'$.unbilledSale.tax'),'.','') AS INTEGER)=0
        THEN json_array(
          json_object('account','418','debitBani',CAST(CAST(replace(json_extract(p.body,'$.unbilledSale.gross'),'.','') AS INTEGER) AS TEXT),'creditBani','0'),
          json_object('account',json_extract(p.body,'$.unbilledSale.account'),'debitBani','0','creditBani',CAST(CAST(replace(json_extract(p.body,'$.unbilledSale.net'),'.','') AS INTEGER) AS TEXT)))
        ELSE json_array(
          json_object('account','418','debitBani',CAST(CAST(replace(json_extract(p.body,'$.unbilledSale.gross'),'.','') AS INTEGER) AS TEXT),'creditBani','0'),
          json_object('account',json_extract(p.body,'$.unbilledSale.account'),'debitBani','0','creditBani',CAST(CAST(replace(json_extract(p.body,'$.unbilledSale.net'),'.','') AS INTEGER) AS TEXT)),
          json_object('account','4427','debitBani','0','creditBani',CAST(CAST(replace(json_extract(p.body,'$.unbilledSale.tax'),'.','') AS INTEGER) AS TEXT))) END
  ) THEN RAISE(ABORT,'invalid_unbilled_sale_origin') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_projection_insert BEFORE INSERT ON acc_unbilled_sale_postings BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general'
      AND p.id=NEW.unbilled_sale_id AND json_extract(p.body,'$.unbilledSale.reference')=NEW.reference
  ) THEN RAISE(ABORT,'invalid_unbilled_sale_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_unbilled_sale AFTER INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_unbilled_sale_postings(company_id,unbilled_sale_id,journal_id,reference,created_by,created_at)
  SELECT NEW.company_id,p.id,NEW.id,json_extract(p.body,'$.unbilledSale.reference'),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
    AND json_type(p.body,'$.unbilledSale')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_unbilled_sale_match BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.unbilledSaleMatch')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.purpose')='sale' AND json_extract(p.body,'$.invoice.direction')='sale'
      AND json_extract(d.body,'$.issueDate')=NEW.date
      AND json_array_length(p.body,'$.invoice.unbilledSaleMatch.allocations') BETWEEN 1 AND 100
      AND (SELECT sum(CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a)=CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)
      AND (SELECT sum(CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a)=CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)
      AND NEW.lines_json=json_array(
        json_object('account','4111','debitBani',CAST(CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) AS TEXT),'creditBani','0'),
        json_object('account','418','debitBani','0','creditBani',CAST(CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) AS TEXT)))
  ) THEN RAISE(ABORT,'invalid_unbilled_sale_match_origin') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p JOIN json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND NOT EXISTS (
      SELECT 1 FROM acc_unbilled_sale_postings ap
      JOIN acc_proposals original ON original.company_id=ap.company_id AND original.id=ap.unbilled_sale_id
      JOIN acc_journals j ON j.company_id=ap.company_id AND j.id=ap.journal_id
      WHERE ap.company_id=p.company_id AND ap.unbilled_sale_id=json_extract(a.value,'$.unbilledSaleId')
        AND j.id=json_extract(a.value,'$.originalJournalId') AND j.date<=NEW.date
        AND original.hash=json_extract(a.value,'$.proposalHash')
        AND json_extract(original.body,'$.financialYearId')=json_extract(a.value,'$.originalFinancialYearId')
        AND json_extract(a.value,'$.positionVersion')=(SELECT count(*) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id)
        AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)>0
        AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)>=0
        AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)=CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)+CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)+coalesce((SELECT sum(m.net_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id),0)<=CAST(replace(json_extract(original.body,'$.unbilledSale.net'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(m.tax_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id),0)<=CAST(replace(json_extract(original.body,'$.unbilledSale.tax'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.unbilledSale.gross'),'.','') AS INTEGER)-coalesce((SELECT sum(m.gross_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id),0)
        AND CAST(replace(json_extract(a.value,'$.remainingGross'),'.','') AS INTEGER)=CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)-CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.remainingGross'),'.','') AS INTEGER)>=0
    )
  ) THEN RAISE(ABORT,'stale_or_excessive_unbilled_sale_match') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_match_insert BEFORE INSERT ON acc_unbilled_sale_matches BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_invoice_postings ip JOIN acc_proposals p ON p.company_id=ip.company_id AND p.id=ip.proposal_id
    JOIN json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a
    WHERE ip.company_id=NEW.company_id AND ip.invoice_id=NEW.invoice_id
      AND json_extract(a.value,'$.unbilledSaleId')=NEW.unbilled_sale_id
      AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)=NEW.net_bani
      AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)=NEW.tax_bani
      AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)=NEW.gross_bani
  ) THEN RAISE(ABORT,'invalid_unbilled_sale_match_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_unbilled_sale_matches AFTER INSERT ON acc_invoice_postings BEGIN
  INSERT INTO acc_unbilled_sale_matches(company_id,invoice_id,unbilled_sale_id,net_bani,tax_bani,gross_bani)
  SELECT NEW.company_id,NEW.invoice_id,json_extract(a.value,'$.unbilledSaleId'),
    CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER),
    CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER),
    CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
  FROM acc_proposals p JOIN json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a
  WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id;
END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_posting_update BEFORE UPDATE ON acc_unbilled_sale_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_posting_delete BEFORE DELETE ON acc_unbilled_sale_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_match_update BEFORE UPDATE ON acc_unbilled_sale_matches BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_match_delete BEFORE DELETE ON acc_unbilled_sale_matches BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
