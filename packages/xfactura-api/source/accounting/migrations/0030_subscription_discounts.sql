-- Custom SQLite invariant triggers only; no table/index/column changes.
-- Preserve the existing cancellation guard and admit only the separately guarded commercial discount.
DROP TRIGGER acc_guard_deferral_credit;
--> statement-breakpoint
CREATE TRIGGER acc_guard_deferral_credit BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_deferral_postings d ON d.company_id=p.company_id
      AND d.invoice_id=json_extract(p.body,'$.invoice.credit.originalInvoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.deferralCredit') IS NOT 'object'
      AND json_type(p.body,'$.invoice.deferralDiscount') IS NOT 'object'
  ) THEN RAISE(ABORT,'deferral_credit_treatment_required') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.deferralCredit')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_deferral_postings d ON d.company_id=p.company_id
      AND d.deferral_id=json_extract(p.body,'$.invoice.deferralCredit.deferralId')
    JOIN acc_proposals original ON original.company_id=d.company_id AND original.id=d.deferral_id
    JOIN acc_evidence e ON e.company_id=p.company_id
      AND e.id=json_extract(p.body,'$.invoice.treatmentEvidenceId')
    JOIN acc_invoice_documents credit ON credit.company_id=p.company_id
      AND credit.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.invoice.credit.originalInvoiceId')=d.invoice_id
      AND json_extract(p.body,'$.invoice.credit.kind')='cancellation'
      AND json_extract(p.body,'$.invoice.credit.periodBasis')='current_period_event'
      AND json_type(p.body,'$.invoice.deferral') IS NULL
      AND json_type(p.body,'$.invoice.deferralDiscount') IS NULL
      AND json_type(p.body,'$.invoice.accrualMatch') IS NULL
      AND json_type(p.body,'$.invoice.unbilledSaleMatch') IS NULL
      AND json_extract(credit.body,'$.documentType')='credit_note'
      AND NEW.evidence_id=credit.evidence_id
      AND e.id<>credit.evidence_id
      AND e.id<>json_extract(original.body,'$.invoice.treatmentEvidenceId')
      AND e.id<>json_extract(original.body,'$.evidenceId')
      AND e.hash=json_extract(p.body,'$.invoice.deferralCredit.evidenceHash')
      AND json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')=date(json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'),'start of month')
      AND json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')>=NEW.date
      AND json_extract(p.body,'$.invoice.credit.decisionDate') BETWEEN json_extract(original.body,'$.date') AND NEW.date
      AND json_extract(p.body,'$.invoice.credit.decisionDate')<=json_extract(credit.body,'$.issueDate')
      AND substr(NEW.date,1,7)=substr(json_extract(credit.body,'$.issueDate'),1,7)
      AND substr(NEW.date,1,7)=substr(json_extract(p.body,'$.invoice.credit.decisionDate'),1,7)
      AND json_extract(p.body,'$.invoice.deferralCredit.cancelTo')=date(json_extract(original.body,'$.invoice.deferral.serviceTo'),'start of month')
      AND EXISTS (
        SELECT 1 FROM json_each(original.body,'$.invoice.deferral.schedule') s
        WHERE json_extract(s.value,'$.month')=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND json_extract(p.body,'$.invoice.deferralCredit.months')=(
        SELECT json_group_array(json(s.value)) FROM json_each(original.body,'$.invoice.deferral.schedule') s
        WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)=(
        SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER))
        FROM json_each(original.body,'$.invoice.deferral.schedule') s
        WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)>0
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)=
        CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase'
          THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER)
          ELSE CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER) END
      AND json_extract(p.body,'$.invoice.deferralCredit.priorReleaseCount')=(
        SELECT count(*) FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id
      )
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.allocated'),'.','') AS INTEGER)=coalesce((
        SELECT sum(r.amount_bani) FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id
      ),0)
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.remainingBefore'),'.','') AS INTEGER)=
        CAST(replace(json_extract(original.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.allocated'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.remainingAfter'),'.','') AS INTEGER)=
        CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.remainingBefore'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)
      AND NOT EXISTS (
        SELECT 1 FROM acc_deferral_releases r JOIN acc_journals j ON j.company_id=r.company_id AND j.id=r.journal_id
        WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id
          AND (r.month>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') OR j.date>NEW.date)
      )
      AND NOT EXISTS (SELECT 1 FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id)
      AND NOT EXISTS (SELECT 1 FROM acc_invoice_credits c JOIN acc_journals j ON j.company_id=c.company_id AND j.id=c.journal_id WHERE c.company_id=d.company_id AND c.original_invoice_id=d.invoice_id AND j.date>NEW.date)
      AND json_extract(p.body,'$.invoice.deferralCredit.controlAccount')=
        CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN '471' ELSE '472' END
      AND json_extract(p.body,'$.invoice.account')=json_extract(p.body,'$.invoice.deferralCredit.controlAccount')
      AND NEW.lines_json=(
        SELECT json_group_array(json_object('account',account,'debitBani',CAST(debit AS TEXT),'creditBani',CAST(credit AS TEXT))) FROM (
          SELECT 1 AS ordinal,CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN '401' ELSE '4111' END AS account,
            CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) ELSE 0 END AS debit,
            CASE WHEN json_extract(p.body,'$.invoice.direction')='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) ELSE 0 END AS credit
          UNION ALL SELECT 2,json_extract(p.body,'$.invoice.deferralCredit.controlAccount'),
            CASE WHEN json_extract(p.body,'$.invoice.direction')='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER) ELSE 0 END,
            CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER) ELSE 0 END
          UNION ALL SELECT 3,CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN '4426' ELSE '4427' END,
            CASE WHEN json_extract(p.body,'$.invoice.direction')='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER) ELSE 0 END,
            CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE 0 END
        ) WHERE debit<>0 OR credit<>0 ORDER BY ordinal
      )
  ) THEN RAISE(ABORT,'invalid_or_stale_deferral_cancellation') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_deferral_discount BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.deferralDiscount')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_deferral_postings d ON d.company_id=p.company_id AND d.deferral_id=json_extract(p.body,'$.invoice.deferralDiscount.deferralId')
    JOIN acc_proposals original ON original.company_id=d.company_id AND original.id=d.deferral_id
    JOIN acc_invoice_documents credit ON credit.company_id=p.company_id AND credit.id=json_extract(p.body,'$.invoice.invoiceId')
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=json_extract(p.body,'$.invoice.treatmentEvidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.invoice.credit.originalInvoiceId')=d.invoice_id
      AND json_extract(p.body,'$.invoice.credit.originalJournalId')=d.journal_id AND json_extract(p.body,'$.invoice.credit.originalProposalHash')=original.hash
      AND json_extract(p.body,'$.invoice.credit.originalFinancialYearId')=json_extract(original.body,'$.financialYearId')
      AND json_extract(p.body,'$.invoice.credit.kind')='commercial_discount' AND json_extract(p.body,'$.invoice.credit.periodBasis')='current_period_event'
      AND json_extract(p.body,'$.invoice.deferralDiscount.schemaVersion')=1
      AND json_type(p.body,'$.invoice.deferralDiscount.servicesUnchanged')='true'
      AND json_extract(p.body,'$.invoice.deferralDiscount.ruleReference')='OMFP1802:76(5)'
      AND json_type(p.body,'$.invoice.deferral') IS NULL AND json_type(p.body,'$.invoice.deferralCredit') IS NULL
      AND json_type(p.body,'$.invoice.accrualMatch') IS NULL AND json_type(p.body,'$.invoice.unbilledSaleMatch') IS NULL
      AND json_type(p.body,'$.invoice.advance') IS NULL AND json_type(p.body,'$.invoice.advanceFinal') IS NULL AND json_type(p.body,'$.invoice.advanceCredit') IS NULL
      AND json_type(p.body,'$.settlement') IS NULL AND json_type(p.body,'$.accrual') IS NULL AND json_type(p.body,'$.unbilledSale') IS NULL
      AND json_type(p.body,'$.accrualAdjustment') IS NULL AND json_type(p.body,'$.deferralRelease') IS NULL
      AND json_type(p.body,'$.advancePayment') IS NULL AND json_type(p.body,'$.advanceRefund') IS NULL
      AND json_extract(p.body,'$.correctsJournalId') IS NULL AND json_extract(p.body,'$.purpose')=credit.direction
      AND json_extract(p.body,'$.sourceReference')='invoice:'||credit.id
      AND json_extract(credit.body,'$.documentType')='credit_note' AND NEW.evidence_id=credit.evidence_id
      AND json_extract(p.body,'$.invoice.invoiceHash')=credit.hash
      AND json_extract(p.body,'$.invoice.direction')=json_extract(original.body,'$.invoice.direction') AND credit.direction=json_extract(p.body,'$.invoice.direction')
      AND json_extract(p.body,'$.invoice.net')=json_extract(credit.body,'$.totals.net')
      AND json_extract(p.body,'$.invoice.tax')=json_extract(credit.body,'$.totals.tax')
      AND json_extract(p.body,'$.invoice.gross')=json_extract(credit.body,'$.totals.gross')
      AND json_extract(p.body,'$.invoice.deduction')=json_extract(original.body,'$.invoice.deduction')
      AND json_extract(p.body,'$.invoice.deductibleTax')=CASE WHEN json_extract(original.body,'$.invoice.deduction')='full' THEN json_extract(credit.body,'$.totals.tax') ELSE '0.00' END
      AND json_extract(p.body,'$.invoice.taxPointDate')=json_extract(original.body,'$.invoice.taxPointDate')
      AND json_extract(p.body,'$.invoice.serviceDate')=json_extract(original.body,'$.invoice.serviceDate')
      AND json_extract(p.body,'$.invoice.ruleId')=json_extract(original.body,'$.invoice.ruleId') AND json_extract(p.body,'$.invoice.ruleHash')=json_extract(original.body,'$.invoice.ruleHash')
      AND e.id<>credit.evidence_id AND e.id<>json_extract(original.body,'$.evidenceId') AND e.id<>json_extract(original.body,'$.invoice.treatmentEvidenceId')
      AND e.hash=json_extract(p.body,'$.invoice.deferralDiscount.evidenceHash')
      AND json_extract(p.body,'$.invoice.deferralDiscount.sourceAmount')=json_extract(original.body,'$.invoice.deferral.amount')
      AND NEW.date>=json_extract(credit.body,'$.issueDate') AND NEW.date>=json_extract(original.body,'$.date')
      AND json_extract(p.body,'$.invoice.credit.decisionDate') BETWEEN json_extract(original.body,'$.date') AND json_extract(credit.body,'$.issueDate')
      AND substr(NEW.date,1,7)=substr(json_extract(credit.body,'$.issueDate'),1,7)
      AND substr(NEW.date,1,7)=substr(json_extract(p.body,'$.invoice.credit.decisionDate'),1,7)
      AND NOT EXISTS (SELECT 1 FROM acc_invoice_credits c JOIN acc_journals j ON j.company_id=c.company_id AND j.id=c.journal_id WHERE c.company_id=d.company_id AND c.original_invoice_id=d.invoice_id AND j.date>NEW.date)
      AND json_extract(p.body,'$.invoice.deferralDiscount.cancellationJournalId') IS (SELECT c.journal_id FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id)
      AND json_extract(p.body,'$.invoice.deferralDiscount.controlAccount')=CASE WHEN credit.direction='purchase' THEN '471' ELSE '472' END
      AND json_extract(p.body,'$.invoice.deferralDiscount.account')=CASE WHEN credit.direction='purchase' THEN '609' ELSE '709' END
      AND json_extract(p.body,'$.invoice.account')=json_extract(p.body,'$.invoice.deferralDiscount.account')
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralDiscount.amount'),'.','') AS INTEGER)>0
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralDiscount.amount'),'.','') AS INTEGER)=CASE WHEN credit.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER) END
      AND NEW.lines_json=(SELECT json_group_array(json_object('account',account,'debitBani',CAST(debit AS TEXT),'creditBani',CAST(credit AS TEXT))) FROM (
        SELECT 1 AS ordinal,CASE WHEN credit.direction='purchase' THEN '401' ELSE '4111' END AS account,
          CASE WHEN credit.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) ELSE 0 END AS debit,
          CASE WHEN credit.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) ELSE 0 END AS credit
        UNION ALL SELECT 2,json_extract(p.body,'$.invoice.deferralDiscount.account'),
          CASE WHEN credit.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.deferralDiscount.amount'),'.','') AS INTEGER) ELSE 0 END,
          CASE WHEN credit.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.deferralDiscount.amount'),'.','') AS INTEGER) ELSE 0 END
        UNION ALL SELECT 3,CASE WHEN credit.direction='purchase' THEN '4426' ELSE '4427' END,
          CASE WHEN credit.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER) ELSE 0 END,
          CASE WHEN credit.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE 0 END
      ) WHERE debit<>0 OR credit<>0 ORDER BY ordinal)
  ) THEN RAISE(ABORT,'invalid_or_stale_deferral_discount') END;
END;
