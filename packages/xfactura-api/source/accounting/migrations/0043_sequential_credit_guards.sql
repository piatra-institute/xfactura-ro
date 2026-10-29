-- Drizzle generated this custom migration shell. Only unsupported SQLite trigger definitions are explicit SQL.
-- Ordinary columns/indexes come from generated 0042. Earlier applied migrations remain unchanged.
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
    LEFT JOIN acc_deferral_cancellations prior ON prior.company_id=d.company_id AND prior.deferral_id=d.deferral_id AND prior.sequence=(SELECT max(c.sequence) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id)
    LEFT JOIN acc_journals prior_journal ON prior_journal.company_id=prior.company_id AND prior_journal.id=prior.journal_id
    LEFT JOIN acc_proposals prior_proposal ON prior_proposal.company_id=prior_journal.company_id AND prior_proposal.id=prior_journal.source_id
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
        SELECT 1 FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s
        WHERE json_extract(s.value,'$.month')=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND json_extract(p.body,'$.invoice.deferralCredit.months')=(
        SELECT json_group_array(json(s.value)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s
        WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
      )
      AND (
        (json_extract(p.body,'$.invoice.deferralCredit.schemaVersion')=1
         AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)=(SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')))
        OR (json_extract(p.body,'$.invoice.deferralCredit.schemaVersion')=2
         AND json_extract(p.body,'$.invoice.deferralCredit.changeBasis')='cancelled_future_services'
         AND json_extract(p.body,'$.invoice.deferralCredit.remainingServices')='uniform'
         AND json_extract(p.body,'$.invoice.deferralCredit.method')=json_extract(original.body,'$.invoice.deferral.method')
         AND NEW.date>=json_extract(credit.body,'$.issueDate')
         AND NOT EXISTS(SELECT 1 FROM acc_deferral_reschedules prior WHERE prior.company_id=d.company_id AND prior.deferral_id=d.deferral_id AND prior.evidence_id=e.id)
         AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)<(SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))
         AND json_extract(p.body,'$.invoice.deferralCredit.beforeSchedule')=coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))
         AND json_type(p.body,'$.invoice.deferralCredit.afterSchedule')='array'
         AND json_array_length(p.body,'$.invoice.deferralCredit.afterSchedule')=json_array_length(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule')))
         AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.deferralCredit.afterSchedule') s)=CAST(replace(json_extract(original.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)-coalesce((SELECT sum(c.amount_bani) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id),0)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)
         AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferralCredit.afterSchedule') s
           LEFT JOIN json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) b ON b.key=s.key
           WHERE (
             json_extract(s.value,'$.month')=json_extract(b.value,'$.month')
             AND json_extract(s.value,'$.date')=json_extract(b.value,'$.date')
             AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)>=0
             AND (
               (json_extract(s.value,'$.month')<json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') AND s.value=b.value)
               OR (json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') AND (
                 (json_extract(p.body,'$.invoice.deferralCredit.method')='equal_calendar_months'
                   AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)=CASE
                     WHEN json_extract(s.value,'$.month')=json_extract(p.body,'$.invoice.deferralCredit.cancelTo') THEN ((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))-(((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/json_array_length(p.body,'$.invoice.deferralCredit.months'))*(json_array_length(p.body,'$.invoice.deferralCredit.months')-1)
                     ELSE ((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/json_array_length(p.body,'$.invoice.deferralCredit.months') END)
                 OR (json_extract(p.body,'$.invoice.deferralCredit.method')='actual_calendar_days'
                   AND json_type(s.value,'$.days')='integer' AND json_extract(s.value,'$.days')=json_extract(b.value,'$.days')
                   AND json_extract(s.value,'$.serviceFrom')=json_extract(b.value,'$.serviceFrom')
                   AND json_extract(s.value,'$.serviceTo')=json_extract(b.value,'$.serviceTo')
                   AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)=((((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))+(((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))%CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))-((((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom')) AS INTEGER))+(((SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER))%CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER))*(CAST(julianday(json_extract(s.value,'$.serviceFrom'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom')) AS INTEGER))/CAST(julianday(json_extract(p.body,'$.invoice.deferralCredit.months[#-1].serviceTo'))-julianday(json_extract(p.body,'$.invoice.deferralCredit.months[0].serviceFrom'))+1 AS INTEGER)))
               ))
             )
           ) IS NOT 1)
         AND NOT EXISTS(SELECT 1 FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) b
           WHERE json_extract(b.value,'$.date')<=NEW.date AND CAST(replace(json_extract(b.value,'$.amount'),'.','') AS INTEGER)>0
             AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND r.month=json_extract(b.value,'$.month')))
         AND NOT EXISTS(SELECT 1 FROM acc_periods locked WHERE locked.company_id=d.company_id AND locked.closed_at IS NOT NULL
           AND EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferralCredit.months') m WHERE json_extract(m.value,'$.month')=locked.month))
        ) OR (json_extract(p.body,'$.invoice.deferralCredit.schemaVersion')=3
         AND json_extract(p.body,'$.invoice.deferralCredit.changeBasis')='cancelled_future_services'
         AND json_extract(p.body,'$.invoice.deferralCredit.remainingServices')='documented_monthly_benefits'
         AND json_extract(p.body,'$.invoice.deferralCredit.method')='evidenced_monthly_amounts'
         AND json_extract(original.body,'$.invoice.deferral.schemaVersion')=3
         AND json_extract(original.body,'$.invoice.deferral.method')='evidenced_monthly_amounts'
         AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r JOIN acc_journals rj ON rj.company_id=r.company_id AND rj.id=r.journal_id WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND rj.evidence_id=e.id)
         AND NEW.date>=json_extract(credit.body,'$.issueDate')
         AND NOT EXISTS(SELECT 1 FROM acc_deferral_reschedules prior WHERE prior.company_id=d.company_id AND prior.deferral_id=d.deferral_id AND prior.evidence_id=e.id)
         AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)<(SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s WHERE json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'))
         AND json_extract(p.body,'$.invoice.deferralCredit.beforeSchedule')=coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))
         AND json_type(p.body,'$.invoice.deferralCredit.afterSchedule')='array'
         AND json_array_length(p.body,'$.invoice.deferralCredit.afterSchedule')=json_array_length(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule')))
         AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.deferralCredit.afterSchedule') s)=CAST(replace(json_extract(original.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)-coalesce((SELECT sum(c.amount_bani) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id),0)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)
         AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.deferralCredit.afterSchedule') s
           LEFT JOIN json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) b ON b.key=s.key
           WHERE (
             json_extract(s.value,'$.month')=json_extract(b.value,'$.month')
             AND json_extract(s.value,'$.date')=json_extract(b.value,'$.date')
             AND json_extract(s.value,'$.serviceFrom')=json_extract(b.value,'$.serviceFrom')
             AND json_extract(s.value,'$.serviceTo')=json_extract(b.value,'$.serviceTo')
             AND ((json_extract(s.value,'$.month')<json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') AND s.value=b.value)
               OR (json_extract(s.value,'$.month')>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')
                 AND json_type(s.value,'$.benefit')='text' AND length(trim(json_extract(s.value,'$.benefit'))) BETWEEN 10 AND 500
                 AND json_type(s.value,'$.amount')='text'
                 AND CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER) BETWEEN 0 AND CAST(replace(json_extract(b.value,'$.amount'),'.','') AS INTEGER)
                 AND printf('%d.%02d',CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)/100,CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)%100)=json_extract(s.value,'$.amount')
               ))
           ) IS NOT 1)
         AND NOT EXISTS(SELECT 1 FROM json_each(coalesce(CASE WHEN prior.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT prior.journal_id THEN json_extract(prior_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) b
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
        CAST(replace(json_extract(original.body,'$.invoice.deferral.amount'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.allocated'),'.','') AS INTEGER)-coalesce((SELECT sum(c.amount_bani) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id),0)
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.remainingAfter'),'.','') AS INTEGER)=
        CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.remainingBefore'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)
      AND NOT EXISTS (
        SELECT 1 FROM acc_deferral_releases r JOIN acc_journals j ON j.company_id=r.company_id AND j.id=r.journal_id
        WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id
          AND (r.month>=json_extract(p.body,'$.invoice.deferralCredit.cancelFrom') OR j.date>NEW.date)
      )
      AND ((prior.journal_id IS NULL AND json_type(p.body,'$.invoice.deferralCredit.priorCancellation') IS NULL)
        OR (prior.journal_id IS NOT NULL
          AND json_extract(prior_proposal.body,'$.invoice.deferralCredit.schemaVersion') IN (2,3)
          AND NEW.date>=prior_journal.date
          AND json_type(p.body,'$.invoice.deferralCredit.priorCancellation')='object'
          AND json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.journalId')=prior.journal_id
          AND json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.invoiceId')=prior.credit_invoice_id
          AND json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.financialYearId')=json_extract(prior_proposal.body,'$.financialYearId')
          AND json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.count')=(SELECT count(*) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id)
          AND (SELECT count(*) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id) BETWEEN 1 AND 127
          AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.amount'),'.','') AS INTEGER)=coalesce((SELECT sum(c.amount_bani) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id),0)
          AND NOT EXISTS(SELECT 1 FROM acc_deferral_reschedules s WHERE s.company_id=d.company_id AND s.deferral_id=d.deferral_id AND s.evidence_id=e.id)
          AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r JOIN acc_journals rj ON rj.company_id=r.company_id AND rj.id=r.journal_id WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND rj.evidence_id=e.id)
        ))
      AND NOT EXISTS(SELECT 1 FROM acc_deferral_cancellations c
        JOIN acc_journals cj ON cj.company_id=c.company_id AND cj.id=c.journal_id
        JOIN acc_proposals cp ON cp.company_id=cj.company_id AND cp.id=cj.source_id
        WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id
          AND e.id IN (json_extract(cp.body,'$.evidenceId'),json_extract(cp.body,'$.invoice.treatmentEvidenceId')))
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
DROP TRIGGER acc_deferral_cancellation_insert;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_cancellation_insert BEFORE INSERT ON acc_deferral_cancellations BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_invoice_credits c JOIN acc_journals j ON j.company_id=c.company_id AND j.id=c.journal_id
    JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE c.company_id=NEW.company_id AND c.credit_invoice_id=NEW.credit_invoice_id AND c.journal_id=NEW.journal_id
      AND json_extract(p.body,'$.invoice.deferralCredit.deferralId')=NEW.deferral_id
      AND json_extract(p.body,'$.invoice.deferralCredit.cancelFrom')=NEW.from_month
      AND json_extract(p.body,'$.invoice.deferralCredit.cancelTo')=NEW.to_month
      AND CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER)=NEW.amount_bani
      AND NEW.sequence=coalesce(json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.count'),0)+1
      AND NEW.sequence=(SELECT count(*) FROM acc_deferral_cancellations c WHERE c.company_id=NEW.company_id AND c.deferral_id=NEW.deferral_id)+1
      AND c.created_by=NEW.created_by AND c.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_deferral_cancellation_projection') END;
END;
--> statement-breakpoint
DROP TRIGGER acc_record_deferral_cancellation;
--> statement-breakpoint
CREATE TRIGGER acc_record_deferral_cancellation AFTER INSERT ON acc_invoice_credits BEGIN
  INSERT INTO acc_deferral_cancellations(company_id,deferral_id,credit_invoice_id,journal_id,from_month,to_month,amount_bani,sequence,created_by,created_at)
  SELECT NEW.company_id,json_extract(p.body,'$.invoice.deferralCredit.deferralId'),NEW.credit_invoice_id,NEW.journal_id,
    json_extract(p.body,'$.invoice.deferralCredit.cancelFrom'),json_extract(p.body,'$.invoice.deferralCredit.cancelTo'),
    CAST(replace(json_extract(p.body,'$.invoice.deferralCredit.amount'),'.','') AS INTEGER),coalesce(json_extract(p.body,'$.invoice.deferralCredit.priorCancellation.count'),0)+1,NEW.created_by,NEW.created_at
  FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
  WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND json_type(p.body,'$.invoice.deferralCredit')='object';
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
    LEFT JOIN acc_deferral_cancellations cancellation ON cancellation.company_id=dp.company_id AND cancellation.deferral_id=dp.deferral_id AND cancellation.sequence=(SELECT max(c.sequence) FROM acc_deferral_cancellations c WHERE c.company_id=dp.company_id AND c.deferral_id=dp.deferral_id)
    LEFT JOIN acc_journals cancellation_journal ON cancellation_journal.company_id=cancellation.company_id AND cancellation_journal.id=cancellation.journal_id
    LEFT JOIN acc_proposals cancellation_proposal ON cancellation_proposal.company_id=cancellation_journal.company_id AND cancellation_proposal.id=cancellation_journal.source_id
    LEFT JOIN acc_deferral_cancellations partial ON partial.company_id=dp.company_id AND partial.deferral_id=dp.deferral_id AND partial.sequence=(
      SELECT max(c.sequence) FROM acc_deferral_cancellations c
      JOIN acc_journals cj ON cj.company_id=c.company_id AND cj.id=c.journal_id
      JOIN acc_proposals cp ON cp.company_id=cj.company_id AND cp.id=cj.source_id
      WHERE c.company_id=dp.company_id AND c.deferral_id=dp.deferral_id AND json_extract(cp.body,'$.invoice.deferralCredit.schemaVersion') IN (2,3))
    LEFT JOIN acc_journals partial_journal ON partial_journal.company_id=partial.company_id AND partial_journal.id=partial.journal_id
    LEFT JOIN acc_proposals partial_proposal ON partial_proposal.company_id=partial_journal.company_id AND partial_proposal.id=partial_journal.source_id
    JOIN json_each(coalesce(CASE WHEN partial.journal_id IS NOT NULL AND json_extract(schedule.body,'$.scopeCredit.journalId') IS NOT partial.journal_id THEN json_extract(partial_proposal.body,'$.invoice.deferralCredit.afterSchedule') END,json_extract(schedule.body,'$.afterSchedule'),json_extract(original.body,'$.invoice.deferral.schedule'))) s
    LEFT JOIN acc_evidence benefit ON benefit.company_id=p.company_id AND benefit.id=json_extract(p.body,'$.deferralRelease.benefitEvidence.evidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice') IS NULL AND json_type(p.body,'$.settlement') IS NULL
      AND json_type(p.body,'$.accrual') IS NULL AND json_type(p.body,'$.accrualAdjustment') IS NULL AND json_type(p.body,'$.unbilledSale') IS NULL
      AND json_extract(p.body,'$.correctsJournalId') IS NULL AND json_extract(p.body,'$.purpose')='general'
      AND dp.invoice_id=json_extract(p.body,'$.deferralRelease.sourceInvoiceId')
      AND json_extract(p.body,'$.deferralRelease.rescheduleId') IS schedule.id
      AND json_extract(p.body,'$.deferralRelease.rescheduleVersion') IS schedule.sequence
      AND (schedule.date IS NULL OR NEW.date>=schedule.date)
      AND (coalesce(json_extract(cancellation_proposal.body,'$.invoice.deferralCredit.schemaVersion'),1) NOT IN (2,3) OR NEW.date>=cancellation_journal.date)
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
        AND NOT EXISTS(SELECT 1 FROM acc_deferral_cancellations c
          JOIN acc_journals cj ON cj.company_id=c.company_id AND cj.id=c.journal_id
          JOIN acc_proposals cp ON cp.company_id=cj.company_id AND cp.id=cj.source_id
          WHERE c.company_id=dp.company_id AND c.deferral_id=dp.deferral_id AND benefit.id IN (json_extract(cp.body,'$.evidenceId'),json_extract(cp.body,'$.invoice.treatmentEvidenceId')))
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
DROP TRIGGER acc_guard_cancelled_deferral_release;
--> statement-breakpoint
CREATE TRIGGER acc_guard_cancelled_deferral_release BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.deferralRelease')='object'
      AND (json_extract(p.body,'$.deferralRelease.cancellationJournalId') IS NOT (
        SELECT c.journal_id FROM acc_deferral_cancellations c WHERE c.company_id=p.company_id AND c.deferral_id=json_extract(p.body,'$.deferralRelease.deferralId') ORDER BY c.sequence DESC LIMIT 1
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
    LEFT JOIN acc_deferral_cancellations cancellation ON cancellation.company_id=d.company_id AND cancellation.deferral_id=d.deferral_id AND cancellation.sequence=(SELECT max(c.sequence) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id)
    LEFT JOIN acc_journals credit_journal ON credit_journal.company_id=cancellation.company_id AND credit_journal.id=cancellation.journal_id
    LEFT JOIN acc_proposals credit_proposal ON credit_proposal.company_id=credit_journal.company_id AND credit_proposal.id=credit_journal.source_id
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
      AND json_extract(NEW.body,'$.beforeSchedule')=CASE WHEN cancellation.journal_id IS NOT NULL AND json_extract(previous.body,'$.scopeCredit.journalId') IS NOT cancellation.journal_id THEN json_extract(credit_proposal.body,'$.invoice.deferralCredit.afterSchedule') ELSE coalesce(json_extract(previous.body,'$.afterSchedule'),json_extract(p.body,'$.invoice.deferral.schedule')) END
      AND EXISTS(SELECT 1 FROM json_each(NEW.body,'$.beforeSchedule') b WHERE json_extract(b.value,'$.month')=json_extract(NEW.body,'$.effectiveFrom'))
      AND ((json_extract(NEW.body,'$.schemaVersion')=1 AND cancellation.journal_id IS NULL AND json_type(NEW.body,'$.scopeCredit') IS NULL)
        OR (json_extract(NEW.body,'$.schemaVersion')=1 AND cancellation.journal_id IS NOT NULL AND json_type(NEW.body,'$.scopeCredit')='object'
          AND json_extract(credit_proposal.body,'$.invoice.deferralCredit.schemaVersion') IN (2,3)
          AND NEW.date>=credit_journal.date
          AND json_extract(NEW.body,'$.scopeCredit.journalId')=cancellation.journal_id
          AND json_extract(NEW.body,'$.scopeCredit.invoiceId')=cancellation.credit_invoice_id
          AND json_extract(NEW.body,'$.scopeCredit.financialYearId')=json_extract(credit_proposal.body,'$.financialYearId')
          AND json_extract(NEW.body,'$.scopeCredit.amount')=json_extract(credit_proposal.body,'$.invoice.deferralCredit.amount')
          AND CAST(replace(json_extract(NEW.body,'$.scopeCredit.amount'),'.','') AS INTEGER)=cancellation.amount_bani
          AND ((cancellation.sequence=1 AND json_type(NEW.body,'$.scopeCredit.priorAmount') IS NULL AND json_type(NEW.body,'$.scopeCredit.priorCount') IS NULL)
            OR (cancellation.sequence>1
              AND json_extract(NEW.body,'$.scopeCredit.priorCount')=cancellation.sequence-1
              AND CAST(replace(json_extract(NEW.body,'$.scopeCredit.priorAmount'),'.','') AS INTEGER)=coalesce((SELECT sum(c.amount_bani) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id),0)-cancellation.amount_bani))
          AND NOT EXISTS(SELECT 1 FROM acc_deferral_cancellations c
            JOIN acc_journals cj ON cj.company_id=c.company_id AND cj.id=c.journal_id
            JOIN acc_proposals cp ON cp.company_id=cj.company_id AND cp.id=cj.source_id
            WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id AND e.id IN (json_extract(cp.body,'$.evidenceId'),json_extract(cp.body,'$.invoice.treatmentEvidenceId')))
          AND e.id<>json_extract(credit_proposal.body,'$.evidenceId') AND e.id<>json_extract(credit_proposal.body,'$.invoice.treatmentEvidenceId')
          AND NOT EXISTS(SELECT 1 FROM acc_deferral_releases r JOIN acc_journals rj ON rj.company_id=r.company_id AND rj.id=r.journal_id WHERE r.company_id=d.company_id AND r.deferral_id=d.deferral_id AND rj.evidence_id=e.id)
        ))
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
      AND (SELECT sum(CAST(replace(json_extract(s.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(NEW.body,'$.afterSchedule') s)=CAST(replace(json_extract(NEW.body,'$.sourceAmount'),'.','') AS INTEGER)-coalesce((SELECT sum(c.amount_bani) FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id),0)
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
--> statement-breakpoint
DROP TRIGGER acc_guard_deferral_discount;
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
    LEFT JOIN acc_deferral_reschedules schedule ON schedule.company_id=d.company_id AND schedule.deferral_id=d.deferral_id AND schedule.sequence=(SELECT max(s.sequence) FROM acc_deferral_reschedules s WHERE s.company_id=d.company_id AND s.deferral_id=d.deferral_id)
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=json_extract(p.body,'$.invoice.treatmentEvidenceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.invoice.credit.originalInvoiceId')=d.invoice_id
      AND json_extract(p.body,'$.invoice.deferralDiscount.rescheduleId') IS schedule.id
      AND json_extract(p.body,'$.invoice.deferralDiscount.rescheduleVersion') IS schedule.sequence
      AND (schedule.date IS NULL OR NEW.date>=schedule.date)
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
      AND json_extract(p.body,'$.invoice.deferralDiscount.cancellationJournalId') IS (SELECT c.journal_id FROM acc_deferral_cancellations c WHERE c.company_id=d.company_id AND c.deferral_id=d.deferral_id ORDER BY c.sequence DESC LIMIT 1)
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
