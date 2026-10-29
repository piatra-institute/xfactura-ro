-- Drizzle-generated custom migration: SQLite trigger definitions are not represented by Drizzle schema.
-- Preserve the two existing allocation methods; enforce explicit monthly benefits and separate service evidence.
DROP TRIGGER acc_guard_deferral_invoice;
--> statement-breakpoint
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
      AND ((json_extract(p.body,'$.invoice.deferral.schemaVersion')=1
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
      ) OR (json_extract(p.body,'$.invoice.deferral.schemaVersion')=2
      AND json_extract(p.body,'$.invoice.deferral.basis')='uniform_service' AND json_extract(p.body,'$.invoice.deferral.method')='actual_calendar_days'
      AND json_extract(p.body,'$.invoice.deferral.taxPointBasis')='early_invoice'
      AND json_extract(p.body,'$.invoice.deferral.dayCountBasis')='actual_inclusive' AND json_extract(p.body,'$.invoice.deferral.rounding')='cumulative_floor_bani'
      AND json_extract(p.body,'$.invoice.deferral.serviceFrom')=date(json_extract(p.body,'$.invoice.deferral.serviceFrom')) AND json_extract(p.body,'$.invoice.deferral.serviceTo')=date(json_extract(p.body,'$.invoice.deferral.serviceTo')) AND json_extract(p.body,'$.invoice.deferral.serviceFrom')<=json_extract(p.body,'$.invoice.deferral.serviceTo')
      AND json_type(p.body,'$.invoice.deferral.serviceDays')='integer' AND json_extract(p.body,'$.invoice.deferral.serviceDays') BETWEEN 1 AND 1860 AND json_extract(p.body,'$.invoice.deferral.serviceDays')=CAST(julianday(json_extract(p.body,'$.invoice.deferral.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferral.serviceFrom'))+1 AS INTEGER)
      AND json_type(p.body,'$.invoice.deferral.schedule')='array' AND json_array_length(p.body,'$.invoice.deferral.schedule') BETWEEN 1 AND 60
      AND json_array_length(p.body,'$.invoice.deferral.schedule')=(CAST(strftime('%Y',json_extract(p.body,'$.invoice.deferral.serviceTo')) AS INTEGER)-CAST(strftime('%Y',json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER))*12+CAST(strftime('%m',json_extract(p.body,'$.invoice.deferral.serviceTo')) AS INTEGER)-CAST(strftime('%m',json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER)+1
      AND json_array_length(p.body,'$.invoice.deferral.schedule')=(SELECT count(DISTINCT json_extract(s.value,'$.month')) FROM json_each(p.body,'$.invoice.deferral.schedule') s)
      AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.deferral.schedule') s)=CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)>0 AND CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)=CASE WHEN d.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER) END
      AND (SELECT sum(json_extract(s.value,'$.days')) FROM json_each(p.body,'$.invoice.deferral.schedule') s)=json_extract(p.body,'$.invoice.deferral.serviceDays')
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferral.schedule') s WHERE (
        json_extract(s.value,'$.month')=date(json_extract(p.body,'$.invoice.deferral.serviceFrom'),'start of month','+'||s.key||' months')
        AND json_extract(s.value,'$.date')=date(json_extract(s.value,'$.month'),'+1 month','-1 day')
        AND json_extract(s.value,'$.serviceFrom')=max(json_extract(p.body,'$.invoice.deferral.serviceFrom'),json_extract(s.value,'$.month')) AND json_extract(s.value,'$.serviceTo')=min(json_extract(p.body,'$.invoice.deferral.serviceTo'),json_extract(s.value,'$.date'))
        AND json_type(s.value,'$.days')='integer' AND json_extract(s.value,'$.days') BETWEEN 1 AND 31 AND json_extract(s.value,'$.days')=CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(s.value,'$.serviceFrom'))+1 AS INTEGER)
        AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)>=0 AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)=(((CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER))/(json_extract(p.body,'$.invoice.deferral.serviceDays'))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferral.serviceFrom'))+1 AS INTEGER))+((CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER))%(json_extract(p.body,'$.invoice.deferral.serviceDays')))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferral.serviceFrom'))+1 AS INTEGER))/(json_extract(p.body,'$.invoice.deferral.serviceDays')))-((CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER))/(json_extract(p.body,'$.invoice.deferral.serviceDays'))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER))+((CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER))%(json_extract(p.body,'$.invoice.deferral.serviceDays')))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER))/(json_extract(p.body,'$.invoice.deferral.serviceDays'))))
      ) IS NOT 1)
      ) OR (json_extract(p.body,'$.invoice.deferral.schemaVersion')=3
      AND json_extract(p.body,'$.invoice.deferral.basis')='documented_monthly_benefits'
      AND json_extract(p.body,'$.invoice.deferral.method')='evidenced_monthly_amounts'
      AND json_extract(p.body,'$.invoice.deferral.taxPointBasis')='early_invoice'
      AND json_extract(p.body,'$.invoice.deferral.serviceFrom')=date(json_extract(p.body,'$.invoice.deferral.serviceFrom'),'+0 days')
      AND json_extract(p.body,'$.invoice.deferral.serviceTo')=date(json_extract(p.body,'$.invoice.deferral.serviceTo'),'+0 days')
      AND json_extract(p.body,'$.invoice.deferral.serviceFrom')<=json_extract(p.body,'$.invoice.deferral.serviceTo')
      AND json_type(p.body,'$.invoice.deferral.schedule')='array' AND json_array_length(p.body,'$.invoice.deferral.schedule') BETWEEN 1 AND 60
      AND json_array_length(p.body,'$.invoice.deferral.schedule')=(CAST(strftime('%Y',json_extract(p.body,'$.invoice.deferral.serviceTo')) AS INTEGER)-CAST(strftime('%Y',json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER))*12+CAST(strftime('%m',json_extract(p.body,'$.invoice.deferral.serviceTo')) AS INTEGER)-CAST(strftime('%m',json_extract(p.body,'$.invoice.deferral.serviceFrom')) AS INTEGER)+1
      AND CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)>0
      AND CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)=CASE WHEN d.direction='purchase' THEN CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) ELSE CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER) END
      AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.deferral.schedule') s)=CAST(replace(json_extract(p.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferral.schedule') s WHERE (
        json_extract(s.value,'$.month')=date(json_extract(p.body,'$.invoice.deferral.serviceFrom'),'start of month','+'||s.key||' months')
        AND json_extract(s.value,'$.date')=date(json_extract(s.value,'$.month'),'+1 month','-1 day')
        AND json_extract(s.value,'$.serviceFrom')=max(json_extract(p.body,'$.invoice.deferral.serviceFrom'),json_extract(s.value,'$.month'))
        AND json_extract(s.value,'$.serviceTo')=min(json_extract(p.body,'$.invoice.deferral.serviceTo'),json_extract(s.value,'$.date'))
        AND json_type(s.value,'$.benefit')='text' AND length(trim(json_extract(s.value,'$.benefit'))) BETWEEN 10 AND 500
        AND json_type(s.value,'$.amount')='text' AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)>=0
        AND printf('%d.%02d',CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)/100,CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)%100)=json_extract(s.value,'$.amount')
      ) IS NOT 1)
      ))
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
DROP TRIGGER acc_guard_deferral_release;
--> statement-breakpoint
CREATE TRIGGER acc_guard_deferral_release BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.deferralRelease')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_deferral_postings dp ON dp.company_id=p.company_id AND dp.deferral_id=json_extract(p.body,'$.deferralRelease.deferralId')
    JOIN acc_proposals original ON original.company_id=dp.company_id AND original.id=dp.deferral_id
    JOIN acc_journals j ON j.company_id=dp.company_id AND j.id=dp.journal_id
    LEFT JOIN acc_deferral_reschedules schedule ON schedule.company_id=dp.company_id AND schedule.deferral_id=dp.deferral_id AND schedule.sequence=(SELECT max(s.sequence) FROM acc_deferral_reschedules s WHERE s.company_id=dp.company_id AND s.deferral_id=dp.deferral_id)
    LEFT JOIN acc_deferral_cancellations cancellation ON cancellation.company_id=dp.company_id AND cancellation.deferral_id=dp.deferral_id
    LEFT JOIN acc_journals cancellation_journal ON cancellation_journal.company_id=cancellation.company_id AND cancellation_journal.id=cancellation.journal_id
    LEFT JOIN acc_proposals cancellation_proposal ON cancellation_proposal.company_id=cancellation_journal.company_id AND cancellation_proposal.id=cancellation_journal.source_id
    JOIN json_each(coalesce(CASE WHEN json_extract(cancellation_proposal.body,'$.invoice.deferralCredit.schemaVersion')=2 THEN json_extract(cancellation_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s
    LEFT JOIN acc_evidence benefit ON benefit.company_id=p.company_id AND benefit.id=json_extract(p.body,'$.deferralRelease.benefitEvidence.evidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice') IS NULL AND json_type(p.body,'$.settlement') IS NULL
      AND json_type(p.body,'$.accrual') IS NULL AND json_type(p.body,'$.accrualAdjustment') IS NULL AND json_type(p.body,'$.unbilledSale') IS NULL
      AND json_extract(p.body,'$.correctsJournalId') IS NULL AND json_extract(p.body,'$.purpose')='general'
      AND dp.invoice_id=json_extract(p.body,'$.deferralRelease.sourceInvoiceId')
      AND json_extract(p.body,'$.deferralRelease.rescheduleId') IS schedule.id
      AND json_extract(p.body,'$.deferralRelease.rescheduleVersion') IS schedule.sequence
      AND (schedule.date IS NULL OR NEW.date>=schedule.date)
      AND (coalesce(json_extract(cancellation_proposal.body,'$.invoice.deferralCredit.schemaVersion'),1)<>2 OR NEW.date>=cancellation_journal.date)
      AND dp.journal_id=json_extract(p.body,'$.deferralRelease.sourceJournalId') AND original.hash=json_extract(p.body,'$.deferralRelease.sourceProposalHash')
      AND json_extract(original.body,'$.financialYearId')=json_extract(p.body,'$.deferralRelease.sourceFinancialYearId')
      AND json_extract(original.body,'$.invoice.direction')=json_extract(p.body,'$.deferralRelease.direction')
      AND json_extract(original.body,'$.invoice.account')=json_extract(p.body,'$.deferralRelease.account')
      AND json_extract(p.body,'$.deferralRelease.controlAccount')=CASE WHEN json_extract(original.body,'$.invoice.direction')='purchase' THEN '471' ELSE '472' END
      AND ((json_extract(original.body,'$.invoice.deferral.schemaVersion') IN (1,2)
        AND json_extract(original.body,'$.invoice.treatmentEvidenceId')=NEW.evidence_id
        AND json_type(p.body,'$.deferralRelease.benefitEvidence') IS NULL
      ) OR (json_extract(original.body,'$.invoice.deferral.schemaVersion')=3
        AND json_type(p.body,'$.deferralRelease.benefitEvidence')='object'
        AND benefit.id=NEW.evidence_id AND benefit.hash=json_extract(p.body,'$.deferralRelease.benefitEvidence.evidenceHash')
        AND benefit.id<>json_extract(original.body,'$.evidenceId') AND benefit.id<>json_extract(original.body,'$.invoice.treatmentEvidenceId')
        AND json_extract(p.body,'$.deferralRelease.benefitEvidence.evidenceDate')=date(json_extract(p.body,'$.deferralRelease.benefitEvidence.evidenceDate'),'+0 days')
        AND json_extract(p.body,'$.deferralRelease.benefitEvidence.evidenceDate') BETWEEN json_extract(s.value,'$.serviceTo') AND NEW.date
        AND NOT EXISTS(SELECT 1 FROM acc_deferral_reschedules amendment WHERE amendment.company_id=dp.company_id AND amendment.deferral_id=dp.deferral_id AND amendment.evidence_id=benefit.id)
      ))
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
DROP TRIGGER acc_deferral_reschedule_insert;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_reschedule_insert BEFORE INSERT ON acc_deferral_reschedules BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_action_reviews a
    JOIN acc_deferral_postings d ON d.company_id=a.company_id AND d.deferral_id=NEW.deferral_id
    JOIN acc_proposals p ON p.company_id=d.company_id AND p.id=d.deferral_id
    JOIN acc_evidence e ON e.company_id=d.company_id AND e.id=NEW.evidence_id
    JOIN acc_accounting_years y ON y.company_id=d.company_id AND y.id=json_extract(NEW.body,'$.financialYearId') AND y.kind='financial'
    LEFT JOIN acc_deferral_reschedules previous ON previous.company_id=d.company_id AND previous.deferral_id=d.deferral_id
      AND previous.sequence=(SELECT max(s.sequence) FROM acc_deferral_reschedules s WHERE s.company_id=d.company_id AND s.deferral_id=d.deferral_id)
    WHERE a.company_id=NEW.company_id AND a.id=NEW.id AND a.operation='deferrals.reschedule'
      AND a.approved_by IS NOT NULL AND a.approved_at IS NOT NULL AND a.executed_at IS NULL AND a.result IS NULL
      AND EXISTS(SELECT 1 FROM acc_memberships m WHERE m.company_id=NEW.company_id AND m.user_id=a.approved_by AND m.active=1 AND m.role IN ('owner','reviewer'))
      AND a.effect=NEW.body
      AND EXISTS(SELECT 1 FROM acc_memberships m WHERE m.company_id=NEW.company_id AND m.user_id=NEW.created_by AND m.active=1 AND m.role IN ('owner','reviewer'))
      AND NEW.sequence=coalesce(previous.sequence,0)+1 AND json_extract(NEW.body,'$.sequence')=NEW.sequence
      AND json_extract(NEW.body,'$.priorRescheduleId') IS previous.id
      AND (previous.date IS NULL OR previous.date<=NEW.date)
      AND json_extract(a.input,'$.deferralId')=NEW.deferral_id AND json_extract(NEW.body,'$.deferralId')=NEW.deferral_id
      AND json_extract(a.input,'$.date')=NEW.date AND json_extract(NEW.body,'$.date')=NEW.date
      AND NEW.date=date(NEW.date) AND NEW.date BETWEEN y.date_from AND y.date_to AND NEW.date>=json_extract(p.body,'$.date')
      AND json_extract(a.input,'$.financialYearId')=y.id
      AND json_extract(NEW.body,'$.sourceInvoiceId')=d.invoice_id AND json_extract(NEW.body,'$.sourceJournalId')=d.journal_id
      AND json_extract(NEW.body,'$.sourceProposalHash')=p.hash AND json_extract(NEW.body,'$.sourceFinancialYearId')=json_extract(p.body,'$.financialYearId')
      AND json_extract(NEW.body,'$.direction')=json_extract(p.body,'$.invoice.direction') AND json_extract(NEW.body,'$.account')=json_extract(p.body,'$.invoice.account')
      AND json_extract(NEW.body,'$.controlAccount')=CASE WHEN json_extract(p.body,'$.invoice.direction')='purchase' THEN '471' ELSE '472' END
      AND json_extract(a.input,'$.evidenceId')=e.id AND json_extract(NEW.body,'$.evidenceId')=e.id AND json_extract(NEW.body,'$.evidenceHash')=e.hash
      AND e.id<>json_extract(p.body,'$.evidenceId') AND e.id<>json_extract(p.body,'$.invoice.treatmentEvidenceId')
      AND NOT EXISTS(SELECT 1 FROM acc_deferral_reschedules r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND r.evidence_id=e.id)
      AND json_extract(a.input,'$.evidenceDate')=json_extract(NEW.body,'$.evidenceDate') AND json_extract(NEW.body,'$.evidenceDate') BETWEEN json_extract(p.body,'$.date') AND NEW.date
      AND json_extract(a.input,'$.effectiveFrom')=json_extract(NEW.body,'$.effectiveFrom')
      AND json_extract(NEW.body,'$.effectiveFrom')>=NEW.date AND json_extract(NEW.body,'$.effectiveFrom')=date(json_extract(NEW.body,'$.effectiveFrom'),'start of month')
      AND json_extract(a.input,'$.serviceTo')=json_extract(NEW.body,'$.serviceTo') AND json_extract(NEW.body,'$.serviceTo')>=json_extract(NEW.body,'$.effectiveFrom')
      AND json_extract(NEW.body,'$.serviceTo')=date(json_extract(NEW.body,'$.serviceTo'))
      AND (json_extract(NEW.body,'$.method') IN ('actual_calendar_days','evidenced_monthly_amounts') OR json_extract(NEW.body,'$.serviceTo')=date(json_extract(NEW.body,'$.serviceTo'),'start of month','+1 month','-1 day'))
      AND json_extract(a.input,'$.method')=json_extract(NEW.body,'$.method') AND json_extract(NEW.body,'$.method')=json_extract(p.body,'$.invoice.deferral.method')
      AND json_extract(NEW.body,'$.method') IN ('equal_calendar_months','actual_calendar_days','evidenced_monthly_amounts')
      AND (json_extract(p.body,'$.invoice.deferral.schemaVersion')=1 OR json_extract(NEW.body,'$.effectiveFrom')>=json_extract(p.body,'$.invoice.deferral.serviceFrom'))
      AND ((json_extract(NEW.body,'$.method')='evidenced_monthly_amounts'
        AND json_type(a.input,'$.benefits')='array' AND json_extract(a.input,'$.benefits')=json_extract(NEW.body,'$.benefits')
      ) OR (json_extract(NEW.body,'$.method') IN ('equal_calendar_months','actual_calendar_days')
        AND json_type(a.input,'$.benefits') IS NULL AND json_type(NEW.body,'$.benefits') IS NULL))
      AND json_type(a.input,'$.priceUnchanged')='true'  AND json_type(NEW.body,'$.priceUnchanged')='true'
      AND json_extract(a.input,'$.reason')=json_extract(NEW.body,'$.reason') AND length(json_extract(NEW.body,'$.reason')) BETWEEN 10 AND 1000
      AND json_extract(NEW.body,'$.sourceAmount')=json_extract(p.body,'$.invoice.deferral.amount')
      AND json_extract(NEW.body,'$.beforeSchedule')=coalesce(json_extract(previous.body,'$.afterSchedule'),json_extract(p.body,'$.invoice.deferral.schedule'))
      AND EXISTS(SELECT 1 FROM json_each(NEW.body,'$.beforeSchedule') b WHERE json_extract(b.value,'$.month')=json_extract(NEW.body,'$.effectiveFrom'))
      AND NOT EXISTS(SELECT 1 FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id)
      AND json_extract(NEW.body,'$.priorReleaseCount')=(SELECT count(*) FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id)
      AND CAST(replace(json_extract(NEW.body,'$.allocated'),'.','') AS INTEGER)=coalesce((SELECT sum(r.amount_bani) FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id),0)
      AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r JOIN acc_journals j ON j.company_id=r.company_id AND j.id=r.journal_id WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND (r.month>=json_extract(NEW.body,'$.effectiveFrom') OR j.date>NEW.date))
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.beforeSchedule') b WHERE json_extract(b.value,'$.date')<=NEW.date AND CAST(replace(json_extract(b.value,'$.amount'),'.','') AS INTEGER)>0 AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND r.month=json_extract(b.value,'$.month')))
      AND json_extract(NEW.body,'$.priorCreditCount')=(SELECT count(*) FROM acc_invoice_credits c WHERE c.company_id=d.company_id AND c.original_invoice_id=d.invoice_id)
      AND NOT EXISTS(SELECT 1 FROM acc_invoice_credits c JOIN acc_journals j ON j.company_id=c.company_id AND j.id=c.journal_id WHERE c.company_id=d.company_id AND c.original_invoice_id=d.invoice_id AND j.date>NEW.date)
      AND json_type(NEW.body,'$.afterSchedule')='array' AND json_array_length(NEW.body,'$.afterSchedule') BETWEEN 1 AND 60
      AND json_array_length(NEW.body,'$.afterSchedule')=(SELECT count(DISTINCT json_extract(s.value,'$.month')) FROM json_each(NEW.body,'$.afterSchedule') s)
      AND json_extract(NEW.body,'$.afterSchedule[0].month')=json_extract(NEW.body,'$.beforeSchedule[0].month')
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')<>date(json_extract(NEW.body,'$.afterSchedule[0].month'),'+'||s.key||' months'))
      AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(NEW.body,'$.afterSchedule') s)=CAST(replace(json_extract(NEW.body,'$.sourceAmount'),'.','') AS INTEGER)
      AND json_extract(NEW.body,'$.beforeSchedule')<>json_extract(NEW.body,'$.afterSchedule')
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.beforeSchedule') b WHERE json_extract(b.value,'$.month')<json_extract(NEW.body,'$.effectiveFrom') AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE s.value=b.value))
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')<json_extract(NEW.body,'$.effectiveFrom') AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.beforeSchedule') b WHERE b.value=s.value))
      AND CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER)>0
      AND CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER)=(SELECT sum(CAST(replace(json_extract(b.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(NEW.body,'$.beforeSchedule') b WHERE json_extract(b.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom'))
      AND (SELECT count(*) FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom'))=(CAST(strftime('%Y',json_extract(NEW.body,'$.serviceTo')) AS INTEGER)-CAST(strftime('%Y',json_extract(NEW.body,'$.effectiveFrom')) AS INTEGER))*12+CAST(strftime('%m',json_extract(NEW.body,'$.serviceTo')) AS INTEGER)-CAST(strftime('%m',json_extract(NEW.body,'$.effectiveFrom')) AS INTEGER)+1
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')<>date(json_extract(s.value,'$.month'),'start of month') OR json_extract(s.value,'$.date')<>date(json_extract(s.value,'$.month'),'+1 month','-1 day') OR CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)<0)
      AND ((json_extract(NEW.body,'$.method')='equal_calendar_months'
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom') AND (
        json_extract(s.value,'$.month')>date(json_extract(NEW.body,'$.serviceTo'),'start of month')
        OR CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)<>CASE WHEN json_extract(s.value,'$.month')=date(json_extract(NEW.body,'$.serviceTo'),'start of month') THEN
          CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER)-(CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER)/(SELECT count(*) FROM json_each(NEW.body,'$.afterSchedule') z WHERE json_extract(z.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom')))*((SELECT count(*) FROM json_each(NEW.body,'$.afterSchedule') z WHERE json_extract(z.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom'))-1)
          ELSE CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER)/(SELECT count(*) FROM json_each(NEW.body,'$.afterSchedule') z WHERE json_extract(z.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom')) END))
      ) OR (json_extract(NEW.body,'$.method')='actual_calendar_days'
      AND (SELECT sum(json_extract(s.value,'$.days')) FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom'))=CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER)
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom') AND (
        json_extract(s.value,'$.serviceFrom')=max(json_extract(NEW.body,'$.effectiveFrom'),json_extract(s.value,'$.month')) AND json_extract(s.value,'$.serviceTo')=min(json_extract(NEW.body,'$.serviceTo'),json_extract(s.value,'$.date'))
        AND json_type(s.value,'$.days')='integer' AND json_extract(s.value,'$.days') BETWEEN 1 AND 31 AND json_extract(s.value,'$.days')=CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(s.value,'$.serviceFrom'))+1 AS INTEGER)
        AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)=(((CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER))/(CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER))+((CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER))%(CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER)))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER))/(CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER)))-((CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER))/(CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(NEW.body,'$.effectiveFrom')) AS INTEGER))+((CAST(replace(json_extract(NEW.body,'$.amount'),'.','') AS INTEGER))%(CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER)))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(NEW.body,'$.effectiveFrom')) AS INTEGER))/(CAST(julianday(json_extract(NEW.body,'$.serviceTo'))-julianday(json_extract(NEW.body,'$.effectiveFrom'))+1 AS INTEGER))))
      ) IS NOT 1)
      ) OR (json_extract(NEW.body,'$.method')='evidenced_monthly_amounts'
      AND json_array_length(NEW.body,'$.benefits')=(SELECT count(*) FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')>=json_extract(NEW.body,'$.effectiveFrom'))
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.body,'$.benefits') b WHERE (
        json_extract(b.value,'$.month')=date(json_extract(NEW.body,'$.effectiveFrom'),'+'||b.key||' months')
        AND EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')=json_extract(b.value,'$.month')
          AND json_extract(s.value,'$.amount')=json_extract(b.value,'$.amount') AND json_extract(s.value,'$.benefit')=json_extract(b.value,'$.benefit')
          AND json_extract(s.value,'$.serviceFrom')=max(json_extract(NEW.body,'$.effectiveFrom'),json_extract(s.value,'$.month'))
          AND json_extract(s.value,'$.serviceTo')=min(json_extract(NEW.body,'$.serviceTo'),json_extract(s.value,'$.date'))
          AND json_type(s.value,'$.benefit')='text' AND length(trim(json_extract(s.value,'$.benefit'))) BETWEEN 10 AND 500
          AND json_type(s.value,'$.amount')='text' AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)>=0
          AND printf('%d.%02d',CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)/100,CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)%100)=json_extract(s.value,'$.amount')
        )
      ) IS NOT 1)
      ))
      AND NOT EXISTS(SELECT 1 FROM acc_periods l WHERE l.company_id=d.company_id AND l.closed_at IS NOT NULL AND (l.month=date(NEW.date,'start of month') OR EXISTS(SELECT 1 FROM json_each(NEW.body,'$.beforeSchedule') b WHERE json_extract(b.value,'$.month')=l.month AND l.month>=json_extract(NEW.body,'$.effectiveFrom')) OR EXISTS(SELECT 1 FROM json_each(NEW.body,'$.afterSchedule') s WHERE json_extract(s.value,'$.month')=l.month AND l.month>=json_extract(NEW.body,'$.effectiveFrom'))))
  ) THEN RAISE(ABORT,'invalid_or_stale_deferral_reschedule') END;
END;
