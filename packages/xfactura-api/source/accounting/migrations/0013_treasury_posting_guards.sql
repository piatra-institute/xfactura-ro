-- Drizzle custom migration: rebuildable links to existing immutable invoice journals.
INSERT INTO acc_invoice_postings(company_id,invoice_id,journal_id,proposal_id,created_by,created_at)
SELECT j.company_id,json_extract(p.body,'$.invoice.invoiceId'),j.id,p.id,j.created_by,j.created_at
FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
WHERE j.kind='general' AND json_type(p.body,'$.invoice')='object';
--> statement-breakpoint
CREATE TRIGGER acc_invoice_posting_insert BEFORE INSERT ON acc_invoice_postings BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general' AND p.id=NEW.proposal_id
      AND json_extract(p.body,'$.invoice.invoiceId')=NEW.invoice_id) THEN RAISE(ABORT,'invalid_invoice_posting') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_invoice_credit BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND ((json_extract(d.body,'$.documentType')='credit_note') IS NOT (json_type(p.body,'$.invoice.credit') IS 'object')))
    THEN RAISE(ABORT,'credit_interpretation_required') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice.credit')='object')
    AND NOT EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_invoice_postings ip ON ip.company_id=p.company_id AND ip.invoice_id=json_extract(p.body,'$.invoice.credit.originalInvoiceId')
      JOIN acc_proposals original ON original.company_id=ip.company_id AND original.id=ip.proposal_id
      JOIN acc_journals j ON j.company_id=ip.company_id AND j.id=ip.journal_id
      WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
        AND ip.journal_id=json_extract(p.body,'$.invoice.credit.originalJournalId') AND original.hash=json_extract(p.body,'$.invoice.credit.originalProposalHash')
        AND j.date<=NEW.date AND json_type(original.body,'$.invoice.credit') IS NULL
        AND json_extract(p.body,'$.invoice.credit.priorCreditCount')=(SELECT count(*) FROM acc_invoice_credits c WHERE c.company_id=p.company_id AND c.original_invoice_id=ip.invoice_id)
        AND CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)+coalesce((SELECT sum(c.net_bani) FROM acc_invoice_credits c WHERE c.company_id=p.company_id AND c.original_invoice_id=ip.invoice_id),0)<=CAST(replace(json_extract(original.body,'$.invoice.net'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(c.tax_bani) FROM acc_invoice_credits c WHERE c.company_id=p.company_id AND c.original_invoice_id=ip.invoice_id),0)<=CAST(replace(json_extract(original.body,'$.invoice.tax'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(c.gross_bani) FROM acc_invoice_credits c WHERE c.company_id=p.company_id AND c.original_invoice_id=ip.invoice_id),0)<=CAST(replace(json_extract(original.body,'$.invoice.gross'),'.','') AS INTEGER))
    THEN RAISE(ABORT,'stale_or_excessive_credit') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_invoice_posting AFTER INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_invoice_postings(company_id,invoice_id,journal_id,proposal_id,created_by,created_at)
  SELECT NEW.company_id,json_extract(p.body,'$.invoice.invoiceId'),NEW.id,p.id,NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice')='object';
  INSERT INTO acc_invoice_credits(company_id,credit_invoice_id,original_invoice_id,journal_id,net_bani,tax_bani,gross_bani,deductible_tax_bani,created_by,created_at)
  SELECT NEW.company_id,json_extract(p.body,'$.invoice.invoiceId'),json_extract(p.body,'$.invoice.credit.originalInvoiceId'),NEW.id,
    CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER),CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER),
    CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER),CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice.credit')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_credit_link_insert BEFORE INSERT ON acc_invoice_credits BEGIN
  SELECT CASE WHEN typeof(NEW.net_bani)<>'integer' OR typeof(NEW.tax_bani)<>'integer' OR typeof(NEW.gross_bani)<>'integer' OR typeof(NEW.deductible_tax_bani)<>'integer'
    OR NOT EXISTS(SELECT 1 FROM acc_invoice_postings ip JOIN acc_proposals p ON p.company_id=ip.company_id AND p.id=ip.proposal_id
      WHERE ip.company_id=NEW.company_id AND ip.invoice_id=NEW.credit_invoice_id AND ip.journal_id=NEW.journal_id
        AND json_extract(p.body,'$.invoice.credit.originalInvoiceId')=NEW.original_invoice_id
        AND CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)=NEW.net_bani
        AND CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)=NEW.tax_bani
        AND CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)=NEW.gross_bani
        AND CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER)=NEW.deductible_tax_bani)
    THEN RAISE(ABORT,'invalid_credit_link') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_native_settlement BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.settlement')='object')
    AND NOT EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_movements m ON m.company_id=p.company_id AND m.id=json_extract(p.body,'$.settlement.movementId')
      JOIN acc_treasury_accounts t ON t.company_id=m.company_id AND t.identifier=m.bank_account
      WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND NEW.date=m.date AND NEW.evidence_id=json_extract(p.body,'$.settlement.sourceEvidenceId')
        AND json_extract(p.body,'$.purpose')='general' AND json_type(p.body,'$.invoice') IS NULL
        AND t.ledger_account=json_extract(p.body,'$.settlement.ledgerAccount') AND t.identifier=json_extract(p.body,'$.settlement.account')
        AND NOT EXISTS(SELECT 1 FROM acc_allocations a WHERE a.company_id=m.company_id AND a.movement_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM acc_movement_postings h WHERE h.company_id=m.company_id AND h.movement_id=m.id)
        AND (SELECT sum(CAST(json_extract(value,'$.debitBani') AS INTEGER)-CAST(json_extract(value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) WHERE json_extract(value,'$.account')=t.ledger_account)=m.amount_bani
        AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.settlement.allocations') a WHERE json_extract(a.value,'$.positionVersion') IS NOT (
          (SELECT count(*) FROM acc_invoice_credits c WHERE c.company_id=p.company_id AND c.original_invoice_id=json_extract(a.value,'$.invoiceId'))+
          (SELECT count(*) FROM acc_invoice_settlements s WHERE s.company_id=p.company_id AND s.invoice_id=json_extract(a.value,'$.invoiceId'))))
        AND (t.kind<>'cash' OR json_extract(p.body,'$.settlement.cashJournalCount')=(SELECT count(*) FROM acc_journal_lines l JOIN acc_journals j ON j.company_id=l.company_id AND j.id=l.journal_id
          JOIN acc_accounting_years y ON y.company_id=j.company_id AND y.id=json_extract(p.body,'$.financialYearId') WHERE l.company_id=p.company_id AND l.account=t.ledger_account AND j.date BETWEEN y.date_from AND y.date_to)))
    THEN RAISE(ABORT,'stale_or_invalid_settlement') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_movement_posting_insert BEFORE INSERT ON acc_movement_postings BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_allocations a WHERE a.company_id=NEW.company_id AND a.movement_id=NEW.movement_id)
    OR NOT EXISTS(SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
      WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general' AND p.id=NEW.proposal_id AND json_extract(p.body,'$.settlement.movementId')=NEW.movement_id)
    THEN RAISE(ABORT,'invalid_movement_posting') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_settlement_insert BEFORE INSERT ON acc_invoice_settlements BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_movement_postings h JOIN acc_proposals p ON p.company_id=h.company_id AND p.id=h.proposal_id
      JOIN json_each(p.body,'$.settlement.allocations') a JOIN acc_invoice_postings ip ON ip.company_id=p.company_id AND ip.invoice_id=NEW.invoice_id
      JOIN acc_invoice_documents d ON d.company_id=ip.company_id AND d.id=ip.invoice_id
    WHERE h.company_id=NEW.company_id AND h.movement_id=NEW.movement_id AND json_extract(a.value,'$.invoiceId')=NEW.invoice_id
      AND json_extract(d.body,'$.documentType')='invoice' AND CAST(replace(json_extract(a.value,'$.amount'),'.','') AS INTEGER)=NEW.cleared_bani)
    THEN RAISE(ABORT,'invalid_invoice_settlement') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_native_settlement AFTER INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_movement_postings(company_id,movement_id,journal_id,proposal_id,created_by,created_at)
  SELECT NEW.company_id,json_extract(p.body,'$.settlement.movementId'),NEW.id,p.id,NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.settlement')='object';
  INSERT INTO acc_invoice_settlements(company_id,movement_id,invoice_id,cleared_bani)
  SELECT NEW.company_id,json_extract(p.body,'$.settlement.movementId'),json_extract(a.value,'$.invoiceId'),CAST(replace(json_extract(a.value,'$.amount'),'.','') AS INTEGER)
  FROM acc_proposals p JOIN json_each(p.body,'$.settlement.allocations') a
  WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.settlement')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_legacy_movement BEFORE INSERT ON acc_allocations BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_movement_postings h WHERE h.company_id=NEW.company_id AND h.movement_id=NEW.movement_id) THEN RAISE(ABORT,'already_reconciled') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_journals j JOIN acc_movements m ON m.company_id=j.company_id AND m.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='payment' AND m.id=NEW.movement_id AND -m.amount_bani=NEW.amount_bani)
    THEN RAISE(ABORT,'invalid_legacy_allocation') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_legacy_payment BEFORE INSERT ON acc_journals WHEN NEW.kind='payment' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_movements m JOIN acc_treasury_accounts t ON t.company_id=m.company_id AND t.identifier=m.bank_account
    WHERE m.company_id=NEW.company_id AND m.id=NEW.source_id AND m.date=NEW.date AND m.amount_bani<0
      AND t.kind='bank' AND t.opened_on<=NEW.date
      AND NOT EXISTS(SELECT 1 FROM acc_movement_postings p WHERE p.company_id=m.company_id AND p.movement_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM acc_allocations a WHERE a.company_id=m.company_id AND a.movement_id=m.id)
      AND EXISTS(SELECT 1 FROM acc_statement_movements sm JOIN acc_statements s ON s.company_id=sm.company_id AND s.id=sm.statement_id
        WHERE sm.company_id=m.company_id AND sm.movement_id=m.id AND s.evidence_id=NEW.evidence_id)
      AND NEW.lines_json=json_array(json_object('account','401','debitBani',CAST(-m.amount_bani AS TEXT),'creditBani','0'),
        json_object('account',t.ledger_account,'debitBani','0','creditBani',CAST(-m.amount_bani AS TEXT))))
    THEN RAISE(ABORT,'invalid_or_duplicate_legacy_payment') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_treasury_update BEFORE UPDATE ON acc_treasury_accounts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_treasury_delete BEFORE DELETE ON acc_treasury_accounts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_movement_source_update BEFORE UPDATE ON acc_movement_sources BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_movement_source_delete BEFORE DELETE ON acc_movement_sources BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_movement_posting_update BEFORE UPDATE ON acc_movement_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_movement_posting_delete BEFORE DELETE ON acc_movement_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_settlement_update BEFORE UPDATE ON acc_invoice_settlements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_settlement_delete BEFORE DELETE ON acc_invoice_settlements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_posting_update BEFORE UPDATE ON acc_invoice_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_posting_delete BEFORE DELETE ON acc_invoice_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_credit_update BEFORE UPDATE ON acc_invoice_credits BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_credit_delete BEFORE DELETE ON acc_invoice_credits BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
