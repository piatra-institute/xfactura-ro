-- Hand-written SQLite invariant triggers; ordinary DDL is Drizzle-generated in 0024.
-- Retain the existing settlement path and admit only evidenced advance origins.
DROP TRIGGER acc_movement_posting_insert;
--> statement-breakpoint
CREATE TRIGGER acc_movement_posting_insert BEFORE INSERT ON acc_movement_postings BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_allocations a WHERE a.company_id=NEW.company_id AND a.movement_id=NEW.movement_id)
    OR NOT EXISTS(SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
      WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general' AND p.id=NEW.proposal_id
        AND NEW.movement_id IN (json_extract(p.body,'$.settlement.movementId'),json_extract(p.body,'$.advancePayment.movementId'),json_extract(p.body,'$.advanceRefund.movementId')))
    THEN RAISE(ABORT,'invalid_movement_posting') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_advance_final BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice.advanceFinal')='object') AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents i ON i.company_id=p.company_id AND i.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_extract(i.body,'$.documentType')='invoice'
      AND json_type(p.body,'$.invoice.credit') IS NULL AND json_type(p.body,'$.invoice.advance') IS NULL AND json_type(p.body,'$.invoice.deferral') IS NULL
      AND json_extract(p.body,'$.invoice.net')=json_extract(i.body,'$.totals.net') AND json_extract(p.body,'$.invoice.tax')=json_extract(i.body,'$.totals.tax') AND json_extract(p.body,'$.invoice.gross')=json_extract(i.body,'$.totals.gross')
      AND json_array_length(p.body,'$.invoice.advanceFinal.allocations') BETWEEN 1 AND 100
      AND json_array_length(p.body,'$.invoice.advanceFinal.allocations')=(SELECT count(*) FROM json_each(i.body,'$.lines') l WHERE CAST(json_extract(l.value,'$.net') AS NUMERIC)<0)
      AND CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceNet'),'.','') AS INTEGER)=(SELECT sum(CAST(replace(json_extract(l.value,'$.net'),'.','') AS INTEGER)) FROM json_each(i.body,'$.lines') l WHERE CAST(json_extract(l.value,'$.net') AS NUMERIC)>0)
      AND CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceNet'),'.','') AS INTEGER)-CAST(replace(json_extract(i.body,'$.totals.net'),'.','') AS INTEGER)=(SELECT sum(CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advanceFinal.allocations') a)
      AND CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceTax'),'.','') AS INTEGER)-CAST(replace(json_extract(i.body,'$.totals.tax'),'.','') AS INTEGER)=(SELECT sum(CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advanceFinal.allocations') a)
      AND CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceGross'),'.','') AS INTEGER)=CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceNet'),'.','') AS INTEGER)+CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceTax'),'.','') AS INTEGER)
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.advanceFinal.allocations') a WHERE NOT EXISTS(
        SELECT 1 FROM acc_advance_invoices source JOIN acc_proposals original ON original.company_id=source.company_id AND original.id=source.proposal_id
        JOIN json_each(i.body,'$.lines') l
        WHERE source.company_id=p.company_id AND source.invoice_id=json_extract(a.value,'$.advanceInvoiceId')
          AND json_extract(l.value,'$.id')=json_extract(a.value,'$.lineId') AND CAST(replace(json_extract(l.value,'$.net'),'.','') AS INTEGER)=-CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)
          AND json_extract(original.body,'$.invoice.advance.serviceAccount')=json_extract(p.body,'$.invoice.account')
          AND json_extract(original.body,'$.invoice.direction')=i.direction AND json_extract(original.body,'$.invoice.deduction')=json_extract(p.body,'$.invoice.deduction')
          AND CAST(replace(json_extract(a.value,'$.controlAmount'),'.','') AS INTEGER)=CASE WHEN i.direction='sale' OR json_extract(p.body,'$.invoice.deduction')='full' THEN CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER) END
      ))
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')=json_extract(p.body,'$.invoice.account')),0)=CASE WHEN i.direction='sale' THEN -CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceNet'),'.','') AS INTEGER) WHEN json_extract(p.body,'$.invoice.deduction')='full' THEN CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceNet'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(p.body,'$.invoice.advanceFinal.serviceGross'),'.','') AS INTEGER) END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4092'),0)=CASE WHEN i.direction='purchase' THEN (SELECT sum(CAST(replace(json_extract(a.value,'$.controlAmount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advanceFinal.allocations') a) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='419'),0)=CASE WHEN i.direction='sale' THEN (SELECT sum(CAST(replace(json_extract(a.value,'$.controlAmount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advanceFinal.allocations') a) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='401'),0)=CASE WHEN i.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4111'),0)=CASE WHEN i.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4426'),0)=CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER)
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4427'),0)=CASE WHEN i.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER) ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account') NOT IN(json_extract(p.body,'$.invoice.account'),'4092','419','401','4111','4426','4427'))
  ) THEN RAISE(ABORT,'invalid_advance_final_invoice') END;
END;
--> statement-breakpoint
DROP TRIGGER acc_invoice_settlement_insert;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_settlement_insert BEFORE INSERT ON acc_invoice_settlements BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM acc_movement_postings h JOIN acc_proposals p ON p.company_id=h.company_id AND p.id=h.proposal_id
    JOIN json_each(p.body,'$.settlement.allocations') a JOIN acc_invoice_postings ip ON ip.company_id=p.company_id AND ip.invoice_id=NEW.invoice_id
    JOIN acc_invoice_documents d ON d.company_id=ip.company_id AND d.id=ip.invoice_id
    WHERE h.company_id=NEW.company_id AND h.movement_id=NEW.movement_id AND json_extract(a.value,'$.invoiceId')=NEW.invoice_id
      AND json_extract(d.body,'$.documentType')='invoice' AND CAST(replace(json_extract(a.value,'$.amount'),'.','') AS INTEGER)=NEW.cleared_bani
  ) AND NOT EXISTS(
    SELECT 1 FROM acc_advance_invoice_matches m JOIN acc_advance_payments a ON a.company_id=m.company_id AND a.payment_id=m.payment_id
    WHERE m.company_id=NEW.company_id AND m.invoice_id=NEW.invoice_id AND a.movement_id=NEW.movement_id AND m.gross_bani=NEW.cleared_bani
  ) THEN RAISE(ABORT,'invalid_invoice_settlement') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_advance_payment BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.advancePayment')='object')
  AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_movements m ON m.company_id=p.company_id AND m.id=json_extract(p.body,'$.advancePayment.movementId')
    JOIN acc_treasury_accounts t ON t.company_id=m.company_id AND t.identifier=m.bank_account
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=json_extract(p.body,'$.advancePayment.evidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND NEW.date=m.date AND NEW.evidence_id=json_extract(p.body,'$.advancePayment.sourceEvidenceId')
      AND json_extract(p.body,'$.purpose')='general' AND json_extract(p.body,'$.sourceReference')='advance-payment:'||m.id
      AND t.kind='bank' AND t.currency='RON' AND t.opened_on<=m.date AND t.ledger_account=json_extract(p.body,'$.advancePayment.ledgerAccount')
      AND e.hash=json_extract(p.body,'$.advancePayment.evidenceHash') AND json_extract(p.body,'$.advancePayment.evidenceDate')<=NEW.date AND json_extract(p.body,'$.advancePayment.serviceExpectedOn')>NEW.date
      AND json_extract(p.body,'$.advancePayment.controlAccount')=CASE WHEN json_extract(p.body,'$.advancePayment.direction')='purchase' THEN '4092' ELSE '419' END
      AND CAST(replace(json_extract(p.body,'$.advancePayment.net'),'.','') AS INTEGER)>0
      AND CAST(replace(json_extract(p.body,'$.advancePayment.gross'),'.','') AS INTEGER)=abs(m.amount_bani)
      AND CAST(replace(json_extract(p.body,'$.advancePayment.net'),'.','') AS INTEGER)+CAST(replace(json_extract(p.body,'$.advancePayment.tax'),'.','') AS INTEGER)=abs(m.amount_bani)
      AND (json_extract(p.body,'$.advancePayment.direction')='purchase')=(m.amount_bani<0)
      AND CAST(replace(json_extract(p.body,'$.advancePayment.controlAmount'),'.','') AS INTEGER)=CASE WHEN m.amount_bani<0 THEN -m.amount_bani ELSE CAST(replace(json_extract(p.body,'$.advancePayment.net'),'.','') AS INTEGER) END
      AND NOT EXISTS(SELECT 1 FROM acc_allocations a WHERE a.company_id=m.company_id AND a.movement_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM acc_movement_postings h WHERE h.company_id=m.company_id AND h.movement_id=m.id)
      AND (SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')=t.ledger_account)=m.amount_bani
      AND (SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')=json_extract(p.body,'$.advancePayment.controlAccount'))=CASE WHEN m.amount_bani<0 THEN -m.amount_bani ELSE -CAST(replace(json_extract(p.body,'$.advancePayment.net'),'.','') AS INTEGER) END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4427'),0)=CASE WHEN m.amount_bani>0 THEN CAST(replace(json_extract(p.body,'$.advancePayment.tax'),'.','') AS INTEGER) ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account') NOT IN(t.ledger_account,json_extract(p.body,'$.advancePayment.controlAccount'),CASE WHEN m.amount_bani>0 THEN '4427' ELSE t.ledger_account END))
  ) THEN RAISE(ABORT,'invalid_advance_payment') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_advance_refund BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.advanceRefund')='object')
  AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_advance_payments a ON a.company_id=p.company_id AND a.payment_id=json_extract(p.body,'$.advanceRefund.paymentId')
    JOIN acc_proposals original ON original.company_id=a.company_id AND original.id=a.payment_id
    JOIN acc_movements paid ON paid.company_id=a.company_id AND paid.id=a.movement_id
    JOIN acc_movements m ON m.company_id=p.company_id AND m.id=json_extract(p.body,'$.advanceRefund.movementId')
    JOIN acc_treasury_accounts t ON t.company_id=m.company_id AND t.identifier=m.bank_account
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=json_extract(p.body,'$.advanceRefund.evidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND m.date=NEW.date AND m.amount_bani=-paid.amount_bani AND m.date>=paid.date
      AND NEW.evidence_id=json_extract(p.body,'$.advanceRefund.sourceEvidenceId') AND json_extract(p.body,'$.sourceReference')='advance-refund:'||m.id
      AND t.kind='bank' AND t.currency='RON' AND t.opened_on<=m.date AND t.ledger_account=json_extract(p.body,'$.advanceRefund.ledgerAccount')
      AND json_extract(p.body,'$.advanceRefund.paymentHash')=original.hash AND json_extract(p.body,'$.advanceRefund.paymentJournalId')=a.journal_id
      AND json_extract(p.body,'$.advanceRefund.net')=json_extract(original.body,'$.advancePayment.net') AND json_extract(p.body,'$.advanceRefund.tax')=json_extract(original.body,'$.advancePayment.tax') AND json_extract(p.body,'$.advanceRefund.gross')=json_extract(original.body,'$.advancePayment.gross')
      AND json_extract(p.body,'$.advanceRefund.controlAccount')=json_extract(original.body,'$.advancePayment.controlAccount')
      AND json_extract(p.body,'$.advanceRefund.controlAmount')=json_extract(original.body,'$.advancePayment.controlAmount')
      AND e.hash=json_extract(p.body,'$.advanceRefund.evidenceHash') AND e.id<>json_extract(original.body,'$.advancePayment.evidenceId')
      AND json_extract(p.body,'$.advanceRefund.periodBasis')='current_period_event' AND json_extract(p.body,'$.advanceRefund.decisionDate') BETWEEN paid.date AND m.date
      AND substr(json_extract(p.body,'$.advanceRefund.decisionDate'),1,7)=substr(m.date,1,7)
      AND NOT EXISTS(SELECT 1 FROM acc_advance_invoice_matches r WHERE r.company_id=a.company_id AND r.payment_id=a.payment_id)
      AND NOT EXISTS(SELECT 1 FROM acc_advance_refunds r WHERE r.company_id=a.company_id AND r.payment_id=a.payment_id)
      AND NOT EXISTS(SELECT 1 FROM acc_movement_postings h WHERE h.company_id=m.company_id AND h.movement_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM acc_allocations h WHERE h.company_id=m.company_id AND h.movement_id=m.id)
      AND (SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')=t.ledger_account)=m.amount_bani
      AND (SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')=json_extract(p.body,'$.advanceRefund.controlAccount'))=CASE WHEN m.amount_bani>0 THEN -m.amount_bani ELSE CAST(replace(json_extract(p.body,'$.advanceRefund.net'),'.','') AS INTEGER) END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4427'),0)=CASE WHEN m.amount_bani<0 THEN CAST(replace(json_extract(p.body,'$.advanceRefund.tax'),'.','') AS INTEGER) ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account') NOT IN(t.ledger_account,json_extract(p.body,'$.advanceRefund.controlAccount'),CASE WHEN m.amount_bani<0 THEN '4427' ELSE t.ledger_account END))
  ) THEN RAISE(ABORT,'invalid_or_resolved_advance_refund') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_advance_movement AFTER INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_movement_postings(company_id,movement_id,journal_id,proposal_id,created_by,created_at)
  SELECT NEW.company_id,coalesce(json_extract(p.body,'$.advancePayment.movementId'),json_extract(p.body,'$.advanceRefund.movementId')),NEW.id,p.id,NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND (json_type(p.body,'$.advancePayment')='object' OR json_type(p.body,'$.advanceRefund')='object');
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_advance_payment AFTER INSERT ON acc_movement_postings BEGIN
  INSERT INTO acc_advance_payments(company_id,payment_id,movement_id,journal_id,created_by,created_at)
  SELECT NEW.company_id,p.id,NEW.movement_id,NEW.journal_id,NEW.created_by,NEW.created_at FROM acc_proposals p
  WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id AND json_type(p.body,'$.advancePayment')='object';
  INSERT INTO acc_advance_refunds(company_id,payment_id,movement_id,proposal_id,journal_id,created_by,created_at)
  SELECT NEW.company_id,json_extract(p.body,'$.advanceRefund.paymentId'),NEW.movement_id,p.id,NEW.journal_id,NEW.created_by,NEW.created_at FROM acc_proposals p
  WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id AND json_type(p.body,'$.advanceRefund')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_advance_invoice BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents i ON i.company_id=p.company_id AND i.id=json_extract(p.body,'$.invoice.invoiceId') WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
    AND ((json_extract(i.body,'$.invoiceTypeCode')='386' AND json_type(p.body,'$.invoice.advance') IS NOT 'object') OR (EXISTS(SELECT 1 FROM json_each(i.body,'$.lines') l WHERE CAST(json_extract(l.value,'$.net') AS NUMERIC)<0) AND json_type(p.body,'$.invoice.advanceFinal') IS NOT 'object')))
    THEN RAISE(ABORT,'advance_interpretation_required') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice.advance')='object')
  AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents i ON i.company_id=p.company_id AND i.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_extract(i.body,'$.documentType')='invoice' AND NEW.date=json_extract(i.body,'$.issueDate')
      AND json_type(p.body,'$.invoice.credit') IS NULL AND json_type(p.body,'$.invoice.advanceFinal') IS NULL AND json_type(p.body,'$.invoice.deferral') IS NULL
      AND json_extract(p.body,'$.invoice.net')=json_extract(i.body,'$.totals.net') AND json_extract(p.body,'$.invoice.tax')=json_extract(i.body,'$.totals.tax') AND json_extract(p.body,'$.invoice.gross')=json_extract(i.body,'$.totals.gross')
      AND json_extract(p.body,'$.invoice.advance.serviceExpectedOn')>NEW.date AND json_extract(p.body,'$.invoice.advance.evidenceDate')<=NEW.date
      AND json_extract(p.body,'$.invoice.account')=CASE WHEN i.direction='purchase' THEN '4092' ELSE '419' END
      AND json_extract(p.body,'$.invoice.advance.controlAccount')=json_extract(p.body,'$.invoice.account')
      AND CAST(replace(json_extract(p.body,'$.invoice.advance.amount'),'.','') AS INTEGER)=CASE WHEN i.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) END
      AND (json_array_length(p.body,'$.invoice.advance.payments')=0 OR (
        (SELECT sum(CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a)=CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)
        AND (SELECT sum(CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a)=CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)
        AND (SELECT sum(CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a)=CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)
      ))
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.advance.payments') a WHERE NOT EXISTS(
        SELECT 1 FROM acc_advance_payments r JOIN acc_proposals original ON original.company_id=r.company_id AND original.id=r.payment_id JOIN acc_journals j ON j.company_id=r.company_id AND j.id=r.journal_id
        WHERE r.company_id=p.company_id AND r.payment_id=json_extract(a.value,'$.paymentId') AND r.movement_id=json_extract(a.value,'$.movementId') AND r.journal_id=json_extract(a.value,'$.journalId') AND original.hash=json_extract(a.value,'$.proposalHash') AND j.date<=NEW.date
          AND json_extract(original.body,'$.advancePayment.direction')=i.direction AND json_extract(original.body,'$.advancePayment.account')=json_extract(p.body,'$.invoice.advance.serviceAccount')
          AND json_extract(original.body,'$.advancePayment.net')=json_extract(a.value,'$.net') AND json_extract(original.body,'$.advancePayment.tax')=json_extract(a.value,'$.tax') AND json_extract(original.body,'$.advancePayment.gross')=json_extract(a.value,'$.gross')
          AND NOT EXISTS(SELECT 1 FROM acc_advance_invoice_matches m WHERE m.company_id=r.company_id AND m.payment_id=r.payment_id)
          AND NOT EXISTS(SELECT 1 FROM acc_advance_refunds m WHERE m.company_id=r.company_id AND m.payment_id=r.payment_id)
      ))
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4092'),0)=CASE WHEN i.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.advance.amount'),'.','') AS INTEGER)-coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a),0) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='419'),0)=CASE WHEN i.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)-coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a),0) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='401'),0)=CASE WHEN i.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a),0) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4111'),0)=CASE WHEN i.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a),0) ELSE 0 END
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.debitBani') AS INTEGER)-CAST(json_extract(l.value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4426'),0)=CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER)
      AND coalesce((SELECT sum(CAST(json_extract(l.value,'$.creditBani') AS INTEGER)-CAST(json_extract(l.value,'$.debitBani') AS INTEGER)) FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account')='4427'),0)=CASE WHEN i.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)-coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.advance.payments') a),0) ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.lines_json) l WHERE json_extract(l.value,'$.account') NOT IN('4092','419','401','4111','4426','4427'))
  ) THEN RAISE(ABORT,'invalid_or_stale_advance_invoice') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_advance_invoice AFTER INSERT ON acc_invoice_postings BEGIN
  INSERT INTO acc_advance_invoices(company_id,invoice_id,proposal_id,journal_id,created_by,created_at)
  SELECT NEW.company_id,NEW.invoice_id,NEW.proposal_id,NEW.journal_id,NEW.created_by,NEW.created_at FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id AND json_type(p.body,'$.invoice.advance')='object';
  INSERT INTO acc_advance_invoice_matches(company_id,payment_id,invoice_id,journal_id,net_bani,tax_bani,gross_bani,created_by,created_at)
  SELECT NEW.company_id,json_extract(a.value,'$.paymentId'),NEW.invoice_id,NEW.journal_id,CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER),CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER),CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER),NEW.created_by,NEW.created_at
  FROM acc_proposals p JOIN json_each(p.body,'$.invoice.advance.payments') a WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id;
  INSERT INTO acc_invoice_settlements(company_id,movement_id,invoice_id,cleared_bani)
  SELECT NEW.company_id,json_extract(a.value,'$.movementId'),NEW.invoice_id,CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
  FROM acc_proposals p JOIN json_each(p.body,'$.invoice.advance.payments') a WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id;
  INSERT INTO acc_advance_uses(company_id,advance_invoice_id,final_invoice_id,journal_id,line_id,net_bani,tax_bani,gross_bani,control_bani,created_by,created_at)
  SELECT NEW.company_id,json_extract(a.value,'$.advanceInvoiceId'),NEW.invoice_id,NEW.journal_id,json_extract(a.value,'$.lineId'),CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER),CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER),CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER),CAST(replace(json_extract(a.value,'$.controlAmount'),'.','') AS INTEGER),NEW.created_by,NEW.created_at
  FROM acc_proposals p JOIN json_each(p.body,'$.invoice.advanceFinal.allocations') a WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id;
END;
--> statement-breakpoint
CREATE TRIGGER acc_advance_use_insert BEFORE INSERT ON acc_advance_uses BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM acc_invoice_postings ip JOIN acc_proposals p ON p.company_id=ip.company_id AND p.id=ip.proposal_id JOIN json_each(p.body,'$.invoice.advanceFinal.allocations') a
    JOIN acc_advance_invoices original ON original.company_id=ip.company_id AND original.invoice_id=NEW.advance_invoice_id JOIN acc_proposals source ON source.company_id=original.company_id AND source.id=original.proposal_id
    WHERE ip.company_id=NEW.company_id AND ip.invoice_id=NEW.final_invoice_id AND ip.journal_id=NEW.journal_id AND json_extract(a.value,'$.advanceInvoiceId')=NEW.advance_invoice_id AND json_extract(a.value,'$.lineId')=NEW.line_id
      AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)=NEW.net_bani AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)=NEW.tax_bani AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)=NEW.gross_bani AND CAST(replace(json_extract(a.value,'$.controlAmount'),'.','') AS INTEGER)=NEW.control_bani
      AND source.hash=json_extract(a.value,'$.originalProposalHash') AND original.journal_id=json_extract(a.value,'$.originalJournalId')
      AND json_extract(a.value,'$.priorUseCount')=(SELECT count(*) FROM acc_advance_uses u WHERE u.company_id=NEW.company_id AND u.advance_invoice_id=NEW.advance_invoice_id)
      AND json_extract(a.value,'$.priorCreditCount')=(SELECT count(*) FROM acc_invoice_credits c WHERE c.company_id=NEW.company_id AND c.original_invoice_id=NEW.advance_invoice_id)
      AND NEW.net_bani+coalesce((SELECT sum(u.net_bani) FROM acc_advance_uses u WHERE u.company_id=NEW.company_id AND u.advance_invoice_id=NEW.advance_invoice_id),0)+coalesce((SELECT sum(c.net_bani) FROM acc_invoice_credits c WHERE c.company_id=NEW.company_id AND c.original_invoice_id=NEW.advance_invoice_id),0)<=CAST(replace(json_extract(source.body,'$.invoice.net'),'.','') AS INTEGER)
      AND NEW.tax_bani+coalesce((SELECT sum(u.tax_bani) FROM acc_advance_uses u WHERE u.company_id=NEW.company_id AND u.advance_invoice_id=NEW.advance_invoice_id),0)+coalesce((SELECT sum(c.tax_bani) FROM acc_invoice_credits c WHERE c.company_id=NEW.company_id AND c.original_invoice_id=NEW.advance_invoice_id),0)<=CAST(replace(json_extract(source.body,'$.invoice.tax'),'.','') AS INTEGER)
      AND NEW.gross_bani+coalesce((SELECT sum(u.gross_bani) FROM acc_advance_uses u WHERE u.company_id=NEW.company_id AND u.advance_invoice_id=NEW.advance_invoice_id),0)+coalesce((SELECT sum(c.gross_bani) FROM acc_invoice_credits c WHERE c.company_id=NEW.company_id AND c.original_invoice_id=NEW.advance_invoice_id),0)<=CAST(replace(json_extract(source.body,'$.invoice.gross'),'.','') AS INTEGER)
      AND coalesce((SELECT sum(s.cleared_bani) FROM acc_invoice_settlements s WHERE s.company_id=NEW.company_id AND s.invoice_id=NEW.advance_invoice_id),0)+coalesce((SELECT sum(c.gross_bani) FROM acc_invoice_credits c WHERE c.company_id=NEW.company_id AND c.original_invoice_id=NEW.advance_invoice_id),0)=CAST(replace(json_extract(source.body,'$.invoice.gross'),'.','') AS INTEGER)
      AND ip.created_by=NEW.created_by AND ip.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_or_stale_advance_use') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_advance_credit BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_advance_invoices a ON a.company_id=p.company_id AND a.invoice_id=json_extract(p.body,'$.invoice.credit.originalInvoiceId') WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice.advanceCredit') IS NOT 'object') THEN RAISE(ABORT,'advance_credit_interpretation_required') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_invoice_postings ip ON ip.company_id=p.company_id AND ip.invoice_id=json_extract(p.body,'$.invoice.credit.originalInvoiceId') JOIN acc_proposals original ON original.company_id=ip.company_id AND original.id=ip.proposal_id WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(original.body,'$.invoice.advanceFinal')='object') THEN RAISE(ABORT,'final_invoice_correction_required') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice.advanceCredit')='object') AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_advance_invoices a ON a.company_id=p.company_id AND a.invoice_id=json_extract(p.body,'$.invoice.credit.originalInvoiceId') JOIN acc_proposals original ON original.company_id=a.company_id AND original.id=a.proposal_id
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_extract(p.body,'$.invoice.credit.kind')='cancellation' AND json_extract(p.body,'$.invoice.account')=json_extract(original.body,'$.invoice.account')
      AND json_extract(p.body,'$.invoice.advanceCredit.priorUseCount')=(SELECT count(*) FROM acc_advance_uses u WHERE u.company_id=a.company_id AND u.advance_invoice_id=a.invoice_id)
      AND CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)+coalesce((SELECT sum(u.net_bani) FROM acc_advance_uses u WHERE u.company_id=a.company_id AND u.advance_invoice_id=a.invoice_id),0)+coalesce((SELECT sum(c.net_bani) FROM acc_invoice_credits c WHERE c.company_id=a.company_id AND c.original_invoice_id=a.invoice_id),0)<=CAST(replace(json_extract(original.body,'$.invoice.net'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(u.tax_bani) FROM acc_advance_uses u WHERE u.company_id=a.company_id AND u.advance_invoice_id=a.invoice_id),0)+coalesce((SELECT sum(c.tax_bani) FROM acc_invoice_credits c WHERE c.company_id=a.company_id AND c.original_invoice_id=a.invoice_id),0)<=CAST(replace(json_extract(original.body,'$.invoice.tax'),'.','') AS INTEGER)
  ) THEN RAISE(ABORT,'stale_or_excessive_advance_credit') END;
END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_payments_insert BEFORE INSERT ON acc_advance_payments BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_movement_postings h JOIN acc_proposals p ON p.company_id=h.company_id AND p.id=h.proposal_id WHERE h.company_id=NEW.company_id AND h.movement_id=NEW.movement_id AND h.journal_id=NEW.journal_id AND h.proposal_id=NEW.payment_id AND json_extract(p.body,'$.advancePayment.movementId')=NEW.movement_id AND h.created_by=NEW.created_by AND h.created_at=NEW.created_at) THEN RAISE(ABORT,'invalid_advance_payments_projection') END;
END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_invoices_insert BEFORE INSERT ON acc_advance_invoices BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_invoice_postings h JOIN acc_proposals p ON p.company_id=h.company_id AND p.id=h.proposal_id WHERE h.company_id=NEW.company_id AND h.invoice_id=NEW.invoice_id AND h.journal_id=NEW.journal_id AND h.proposal_id=NEW.proposal_id AND json_type(p.body,'$.invoice.advance')='object' AND h.created_by=NEW.created_by AND h.created_at=NEW.created_at) THEN RAISE(ABORT,'invalid_advance_invoices_projection') END;
END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_invoice_matches_insert BEFORE INSERT ON acc_advance_invoice_matches BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_invoice_postings h JOIN acc_proposals p ON p.company_id=h.company_id AND p.id=h.proposal_id JOIN json_each(p.body,'$.invoice.advance.payments') a WHERE h.company_id=NEW.company_id AND h.invoice_id=NEW.invoice_id AND h.journal_id=NEW.journal_id AND json_extract(a.value,'$.paymentId')=NEW.payment_id AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)=NEW.net_bani AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)=NEW.tax_bani AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)=NEW.gross_bani AND h.created_by=NEW.created_by AND h.created_at=NEW.created_at) THEN RAISE(ABORT,'invalid_advance_invoice_matches_projection') END;
END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_refunds_insert BEFORE INSERT ON acc_advance_refunds BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_movement_postings h JOIN acc_proposals p ON p.company_id=h.company_id AND p.id=h.proposal_id WHERE h.company_id=NEW.company_id AND h.movement_id=NEW.movement_id AND h.journal_id=NEW.journal_id AND h.proposal_id=NEW.proposal_id AND json_extract(p.body,'$.advanceRefund.paymentId')=NEW.payment_id AND h.created_by=NEW.created_by AND h.created_at=NEW.created_at) THEN RAISE(ABORT,'invalid_advance_refunds_projection') END;
END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_payments_update BEFORE UPDATE ON acc_advance_payments BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_payments_delete BEFORE DELETE ON acc_advance_payments BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_invoices_update BEFORE UPDATE ON acc_advance_invoices BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_invoices_delete BEFORE DELETE ON acc_advance_invoices BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_invoice_matches_update BEFORE UPDATE ON acc_advance_invoice_matches BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_invoice_matches_delete BEFORE DELETE ON acc_advance_invoice_matches BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_refunds_update BEFORE UPDATE ON acc_advance_refunds BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_refunds_delete BEFORE DELETE ON acc_advance_refunds BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_uses_update BEFORE UPDATE ON acc_advance_uses BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_advance_uses_delete BEFORE DELETE ON acc_advance_uses BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
