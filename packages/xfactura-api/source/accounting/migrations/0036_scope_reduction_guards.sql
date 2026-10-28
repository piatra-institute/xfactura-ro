-- Custom SQLite invariants only; existing Drizzle tables retain versioned scope cancellations.
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
    LEFT JOIN acc_deferral_reschedules schedule ON schedule.company_id=d.company_id AND schedule.deferral_id=d.deferral_id AND schedule.sequence=(SELECT max(s.sequence) FROM acc_deferral_reschedules s WHERE s.company_id=d.company_id AND s.deferral_id=d.deferral_id)
    JOIN acc_evidence e ON e.company_id=p.company_id
      AND e.id=json_extract(p.body,'$.invoice.treatmentEvidenceId')
    JOIN acc_invoice_documents credit ON credit.company_id=p.company_id
      AND credit.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.invoice.credit.originalInvoiceId')=d.invoice_id
      AND json_extract(p.body,'$.invoice.deferralCredit.rescheduleId') IS schedule.id
      AND json_extract(p.body,'$.invoice.deferralCredit.rescheduleVersion') IS schedule.sequence
      AND (schedule.date IS NULL OR NEW.date>=schedule.date)
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
      AND json_extract(p.body,'$.invoice.deferralCredit.cancelTo')=date(coalesce(json_extract(schedule.body,'$.serviceTo'),json_extract(original.body,'$.invoice.deferral.serviceTo')),'start of month')
      AND EXISTS (
        SELECT 1 FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s
        WHERE json_extract(s.value,'$.month')=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND json_extract(p.body,'$.invoice.deferralCredit.months')=(
        SELECT json_group_array(json(s.value)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s
        WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND (
        (json_extract(p.body,'$.invoice.deferralCredit.schemaVersion')=1
         AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)=(SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')))
        OR (json_extract(p.body,'$.invoice.deferralCredit.schemaVersion')=2
         AND json_extract(p.body,'$.invoice.deferralCredit.changeBasis')='cancelled_future_services'
         AND json_extract(p.body,'$.invoice.deferralCredit.remainingServices')='uniform'
         AND json_extract(p.body,'$.invoice.deferralCredit.method')=json_extract(original.body,'$.invoice.deferral.method')
         AND NEW.date>=json_extract(credit.body,'$.issueDate')
         AND NOT EXISTS(SELECT 1 FROM acc_deferral_reschedules prior WHERE prior.company_id=d.company_id AND prior.deferral_id=d.deferral_id AND prior.evidence_id=e.id)
         AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)<(SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))
         AND json_extract(p.body,'$.invoice.deferralCredit.beforeSchedule')=coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))
         AND json_type(p.body,'$.invoice.deferralCredit.afterSchedule')='array'
         AND json_array_length(p.body,'$.invoice.deferralCredit.afterSchedule')=json_array_length(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule')))
         AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.deferralCredit.afterSchedule') s)=CAST(replace(json_extract(original.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)
         AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferralCredit.afterSchedule') s
           LEFT JOIN json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) b ON b.key=s.key
           WHERE (
             json_extract(s.value,'$.month')=json_extract(b.value,'$.month')
             AND json_extract(s.value,'$.date')=json_extract(b.value,'$.date')
             AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)>=0
             AND (
               (json_extract(s.value,'$.month')<json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') AND s.value=b.value)
               OR (json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') AND (
                 (json_extract(p.body,'$.invoice.deferralCredit.method')='equal_calendar_months'
                   AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)=CASE
                     WHEN json_extract(s.value,'$.month')=json_extract(p.body,'$.invoice.deferralCredit.cancelTo') THEN ((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))-(((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/json_array_length(p.body,'$.invoice.deferralCredit.months'))*(json_array_length(p.body,'$.invoice.deferralCredit.months')-1)
                     ELSE ((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/json_array_length(p.body,'$.invoice.deferralCredit.months') END)
                 OR (json_extract(p.body,'$.invoice.deferralCredit.method')='actual_calendar_days'
                   AND json_type(s.value,'$.days')='integer' AND json_extract(s.value,'$.days')=json_extract(b.value,'$.days')
                   AND json_extract(s.value,'$.serviceFrom')=json_extract(b.value,'$.serviceFrom')
                   AND json_extract(s.value,'$.serviceTo')=json_extract(b.value,'$.serviceTo')
                   AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)=((((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))+(((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))%CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))-((((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom')) AS INTEGER))+(((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))%CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom')) AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER)))
               ))
             )
           ) IS NOT 1)
         AND NOT EXISTS(SELECT 1 FROM json_each(coalesce(json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) b
           WHERE json_extract(b.value,'$.date')<=NEW.date AND CAST(replace(json_extract(b.value,'$.amount'),'.','') AS INTEGER)>0
             AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND r.month=json_extract(b.value,'$.month')))
         AND NOT EXISTS(SELECT 1 FROM acc_periods locked WHERE locked.company_id=d.company_id AND locked.closed_at IS NOT NULL
           AND EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferralCredit.months') m WHERE json_extract(m.value,'$.month')=locked.month))
        )
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
DROP TRIGGER acc_guard_cancelled_deferral_release;
--> statement-breakpoint
CREATE TRIGGER acc_guard_cancelled_deferral_release BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.deferralRelease')='object'
      AND (json_extract(p.body,'$.deferralRelease.cancellationJournalId') IS NOT (
        SELECT c.journal_id FROM acc_deferral_cancellations c WHERE c.company_id=p.company_id AND c.deferral_id=json_extract(p.body,'$.deferralRelease.deferralId')
      ) OR EXISTS (
        SELECT 1 FROM acc_deferral_cancellations c
        JOIN acc_journals cj ON cj.company_id=c.company_id AND cj.id=c.journal_id
        JOIN acc_proposals cp ON cp.company_id=cj.company_id AND cp.id=cj.source_id
        WHERE c.company_id=p.company_id AND c.deferral_id=json_extract(p.body,'$.deferralRelease.deferralId')
          AND json_extract(cp.body,'$.invoice.deferralCredit.schemaVersion')=1
          AND json_extract(p.body,'$.deferralRelease.month') BETWEEN c.from_month AND c.to_month
      ))
  ) THEN RAISE(ABORT,'cancelled_or_stale_deferral_release') END;
END;
