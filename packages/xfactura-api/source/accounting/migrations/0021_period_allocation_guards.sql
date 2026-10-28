-- Drizzle custom migration: exact deferred invoice/schedule links and immutable monthly allocations.
-- Ordinary table/index/foreign-key definitions are generated in 0020.
CREATE TRIGGER acc_guard_deferral_invoice BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.deferral')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=json_extract(p.body,'$.invoice.treatmentEvidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_extract(d.body,'$.documentType')='invoice'
      AND json_type(p.body,'$.invoice.credit') IS NULL AND json_type(p.body,'$.invoice.accrualMatch') IS NULL AND json_type(p.body,'$.invoice.unbilledSaleMatch') IS NULL
      AND json_extract(d.body,'$.issueDate')=NEW.date AND json_extract(p.body,'$.invoice.taxPointDate')=NEW.date
      AND json_extract(p.body,'$.invoice.serviceDate')=json_extract(p.body,'$.invoice.deferral.serviceFrom')
      AND json_extract(p.body,'$.invoice.deferral.serviceFrom')>=NEW.date
      AND json_extract(p.body,'$.invoice.deferral.evidenceDate')<=NEW.date
      AND json_extract(p.body,'$.invoice.deferral.evidenceHash')=e.hash
      AND e.id<>d.evidence_id
      AND json_extract(p.body,'$.invoice.deferral.basis')='uniform_subscription'
      AND json_extract(p.body,'$.invoice.deferral.method')='equal_calendar_months'
      AND json_extract(p.body,'$.invoice.deferral.taxPointBasis')='early_invoice'
      AND json_extract(p.body,'$.invoice.deferral.serviceFrom')=date(json_extract(p.body,'$.invoice.deferral.serviceFrom'),'start of month')
      AND json_extract(p.body,'$.invoice.deferral.serviceTo')=date(json_extract(p.body,'$.invoice.deferral.serviceTo'),'start of month','+1 month','-1 day')
      AND json_array_length(p.body,'$.invoice.deferral.schedule') BETWEEN 1 AND 60
      AND json_array_length(p.body,'$.invoice.deferral.schedule')=(CAST(strftime('%Y',json_extract(p.body,'$.invoice.deferral.serviceTo')) AS INTEGER)-CAST(strftime('%Y',json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER))*12+CAST(strftime('%m',json_extract(p.body,'$.invoice.deferral.serviceTo')) AS INTEGER)-CAST(strftime('%m',json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER)+1
      AND json_array_length(p.body,'$.invoice.deferral.schedule')=(SELECT count(DISTINCT json_extract(s.value,'$.month')) FROM json_each(p.body,'$.invoice.deferral.schedule') s)
      AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.deferral.schedule') s)=CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)=CASE WHEN d.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER) END
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferral.schedule') s WHERE json_extract(s.value,'$.month')<>date(json_extract(s.value,'$.month'),'start of month') OR json_extract(s.value,'$.date')<>date(json_extract(s.value,'$.month'),'+1 month','-1 day') OR CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)<0)
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferral.schedule') s WHERE
        json_extract(s.value,'$.month')<>date(json_extract(p.body,'$.invoice.deferral.serviceFrom'),'+'||s.key||' months')
        OR CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)<>CASE
          WHEN s.key=json_array_length(p.body,'$.invoice.deferral.schedule')-1 THEN CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)-(CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)/json_array_length(p.body,'$.invoice.deferral.schedule'))*(json_array_length(p.body,'$.invoice.deferral.schedule')-1)
          ELSE CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)/json_array_length(p.body,'$.invoice.deferral.schedule') END)
      AND NEW.lines_json=(SELECT json_group_array(json_object('account',account,'debitBani',CAST(debit AS TEXT),'creditBani',CAST(credit AS TEXT))) FROM (
        SELECT 1 AS ordinal,CASE WHEN d.direction='purchase' THEN '471' ELSE '4111' END AS account,
          CAST(replace(json_extract(p.body,CASE WHEN d.direction='purchase' THEN '$.invoice.deferral.amount' ELSE '$.invoice.gross' END),'.','') AS INTEGER) AS debit,0 AS credit
        UNION ALL SELECT 2,CASE WHEN d.direction='purchase' THEN '401' ELSE '472' END,0,
          CAST(replace(json_extract(p.body,CASE WHEN d.direction='purchase' THEN '$.invoice.gross' ELSE '$.invoice.deferral.amount' END),'.','') AS INTEGER)
        UNION ALL SELECT 3,CASE WHEN d.direction='purchase' THEN '4426' ELSE '4427' END,
          CASE WHEN d.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE 0 END,
          CASE WHEN d.direction='sale' THEN CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER) ELSE 0 END
      ) WHERE debit<>0 OR credit<>0 ORDER BY ordinal)
  ) THEN RAISE(ABORT,'invalid_deferral_invoice') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_projection_insert BEFORE INSERT ON acc_deferral_postings BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_invoice_postings ip JOIN acc_proposals p ON p.company_id=ip.company_id AND p.id=ip.proposal_id
    WHERE ip.company_id=NEW.company_id AND ip.invoice_id=NEW.invoice_id AND ip.proposal_id=NEW.deferral_id
      AND ip.journal_id=NEW.journal_id AND json_type(p.body,'$.invoice.deferral')='object'
      AND ip.created_by=NEW.created_by AND ip.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_deferral_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_deferral AFTER INSERT ON acc_invoice_postings BEGIN
  INSERT INTO acc_deferral_postings(company_id,deferral_id,invoice_id,journal_id,created_by,created_at)
  SELECT NEW.company_id,NEW.proposal_id,NEW.invoice_id,NEW.journal_id,NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id AND json_type(p.body,'$.invoice.deferral')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_deferral_release BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.deferralRelease')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_deferral_postings dp ON dp.company_id=p.company_id AND dp.deferral_id=json_extract(p.body,'$.deferralRelease.deferralId')
    JOIN acc_proposals original ON original.company_id=dp.company_id AND original.id=dp.deferral_id
    JOIN acc_journals j ON j.company_id=dp.company_id AND j.id=dp.journal_id
    JOIN json_each(original.body,'$.invoice.deferral.schedule') s
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice') IS NULL AND json_type(p.body,'$.settlement') IS NULL
      AND json_type(p.body,'$.accrual') IS NULL AND json_type(p.body,'$.accrualAdjustment') IS NULL AND json_type(p.body,'$.unbilledSale') IS NULL
      AND json_extract(p.body,'$.correctsJournalId') IS NULL AND json_extract(p.body,'$.purpose')='general'
      AND dp.invoice_id=json_extract(p.body,'$.deferralRelease.sourceInvoiceId')
      AND dp.journal_id=json_extract(p.body,'$.deferralRelease.sourceJournalId') AND original.hash=json_extract(p.body,'$.deferralRelease.sourceProposalHash')
      AND json_extract(original.body,'$.financialYearId')=json_extract(p.body,'$.deferralRelease.sourceFinancialYearId')
      AND json_extract(original.body,'$.invoice.direction')=json_extract(p.body,'$.deferralRelease.direction')
      AND json_extract(original.body,'$.invoice.account')=json_extract(p.body,'$.deferralRelease.account')
      AND json_extract(p.body,'$.deferralRelease.controlAccount')=CASE WHEN json_extract(original.body,'$.invoice.direction')='purchase' THEN '471' ELSE '472' END
      AND json_extract(original.body,'$.invoice.treatmentEvidenceId')=NEW.evidence_id
      AND json_extract(original.body,'$.invoice.deferral.evidenceHash')=json_extract(p.body,'$.deferralRelease.evidenceHash')
      AND json_extract(s.value,'$.month')=json_extract(p.body,'$.deferralRelease.month')
      AND json_extract(s.value,'$.date')=NEW.date AND json_extract(p.body,'$.deferralRelease.date')=NEW.date AND j.date<=NEW.date
      AND json_extract(s.value,'$.amount')=json_extract(p.body,'$.deferralRelease.amount')
      AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)>0
      AND json_extract(p.body,'$.sourceReference')='deferral-release:'||dp.deferral_id||':'||json_extract(s.value,'$.month')
      AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r WHERE r.company_id=p.company_id AND r.deferral_id=dp.deferral_id AND r.month=json_extract(s.value,'$.month'))
      AND NEW.lines_json=json_array(
        json_object('account',CASE WHEN json_extract(original.body,'$.invoice.direction')='purchase' THEN json_extract(original.body,'$.invoice.account') ELSE '472' END,'debitBani',CAST(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER) AS TEXT),'creditBani','0'),
        json_object('account',CASE WHEN json_extract(original.body,'$.invoice.direction')='purchase' THEN '471' ELSE json_extract(original.body,'$.invoice.account') END,'debitBani','0','creditBani',CAST(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER) AS TEXT)))
  ) THEN RAISE(ABORT,'invalid_or_duplicate_deferral_release') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_release_insert BEFORE INSERT ON acc_deferral_releases BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general' AND p.id=NEW.proposal_id
      AND json_extract(p.body,'$.deferralRelease.deferralId')=NEW.deferral_id AND json_extract(p.body,'$.deferralRelease.month')=NEW.month
      AND CAST(replace(json_extract(p.body,'$.deferralRelease.amount'),'.','') AS INTEGER)=NEW.amount_bani
      AND j.created_by=NEW.created_by AND j.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_deferral_release_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_deferral_release AFTER INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_deferral_releases(company_id,deferral_id,month,proposal_id,journal_id,amount_bani,created_by,created_at)
  SELECT NEW.company_id,json_extract(p.body,'$.deferralRelease.deferralId'),json_extract(p.body,'$.deferralRelease.month'),p.id,NEW.id,
    CAST(replace(json_extract(p.body,'$.deferralRelease.amount'),'.','') AS INTEGER),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.deferralRelease')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_deferral_credit BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_deferral_postings dp ON dp.company_id=p.company_id AND dp.invoice_id=json_extract(p.body,'$.invoice.credit.originalInvoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
  ) THEN RAISE(ABORT,'deferral_credit_treatment_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_posting_update BEFORE UPDATE ON acc_deferral_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_posting_delete BEFORE DELETE ON acc_deferral_postings BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_release_update BEFORE UPDATE ON acc_deferral_releases BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_release_delete BEFORE DELETE ON acc_deferral_releases BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
