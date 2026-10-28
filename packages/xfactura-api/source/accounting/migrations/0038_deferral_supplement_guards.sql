-- Custom SQLite invariants only. Table, index, checks and foreign keys are generated in 0037.
CREATE TRIGGER acc_guard_deferral_supplement BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.deferral.supplement') IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_deferral_postings parent ON parent.company_id=p.company_id AND parent.deferral_id=json_extract(p.body,'$.invoice.deferral.supplement.parentDeferralId')
    JOIN acc_proposals original ON original.company_id=parent.company_id AND original.id=parent.deferral_id
    JOIN acc_journals parent_journal ON parent_journal.company_id=parent.company_id AND parent_journal.id=parent.journal_id
    JOIN acc_invoice_documents previous ON previous.company_id=parent.company_id AND previous.id=parent.invoice_id
    JOIN acc_invoice_documents invoice ON invoice.company_id=p.company_id AND invoice.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.deferral.supplement')='object'
      AND json_extract(p.body,'$.invoice.deferral.supplement.schemaVersion')=1
      AND json_extract(p.body,'$.invoice.deferral.supplement.changeBasis')='additional_future_services'
      AND json_extract(p.body,'$.invoice.deferral.supplement.parentInvoiceId')=parent.invoice_id
      AND json_extract(p.body,'$.invoice.deferral.supplement.parentJournalId')=parent.journal_id
      AND json_extract(p.body,'$.invoice.deferral.supplement.parentFinancialYearId')=json_extract(original.body,'$.financialYearId')
      AND json_extract(p.body,'$.invoice.deferral.supplement.parentProposalHash')=original.hash
      AND parent.deferral_id<>p.id AND parent.invoice_id<>invoice.id AND parent_journal.date<=NEW.date
      AND json_extract(invoice.body,'$.documentType')='invoice'
      AND coalesce(json_extract(invoice.body,'$.invoiceTypeCode'),'380')='380'
      AND invoice.direction=previous.direction AND json_extract(invoice.body,'$.currency')='RON'
      AND json_extract(invoice.body,'$.currency')=json_extract(previous.body,'$.currency')
      AND json_extract(invoice.body,'$.supplier.country')='RO' AND json_extract(invoice.body,'$.customer.country')='RO'
      AND (CASE WHEN upper(substr(trim(json_extract(invoice.body,'$.supplier.taxId')),1,2))='RO' THEN substr(trim(json_extract(invoice.body,'$.supplier.taxId')),3) ELSE trim(json_extract(invoice.body,'$.supplier.taxId')) END)
        =(CASE WHEN upper(substr(trim(json_extract(previous.body,'$.supplier.taxId')),1,2))='RO' THEN substr(trim(json_extract(previous.body,'$.supplier.taxId')),3) ELSE trim(json_extract(previous.body,'$.supplier.taxId')) END)
      AND (CASE WHEN upper(substr(trim(json_extract(invoice.body,'$.customer.taxId')),1,2))='RO' THEN substr(trim(json_extract(invoice.body,'$.customer.taxId')),3) ELSE trim(json_extract(invoice.body,'$.customer.taxId')) END)
        =(CASE WHEN upper(substr(trim(json_extract(previous.body,'$.customer.taxId')),1,2))='RO' THEN substr(trim(json_extract(previous.body,'$.customer.taxId')),3) ELSE trim(json_extract(previous.body,'$.customer.taxId')) END)
      AND json_extract(p.body,'$.invoice.account')=json_extract(original.body,'$.invoice.account')
      AND (json_extract(invoice.body,'$.originalInvoiceNumber') IS NULL OR json_extract(invoice.body,'$.originalInvoiceNumber')=json_extract(previous.body,'$.number'))
      AND coalesce(json_array_length(invoice.body,'$.invoiceReferences'),0)<=1
      AND NOT EXISTS(SELECT 1 FROM json_each(invoice.body,'$.lines') line WHERE (CAST(replace(json_extract(line.value,'$.net'),'.','') AS INTEGER)>0) IS NOT 1)
      AND json_extract(p.body,'$.invoice.deferral.evidenceDate')>=parent_journal.date
      AND json_extract(p.body,'$.invoice.treatmentEvidenceId')<>previous.evidence_id
      AND json_extract(p.body,'$.invoice.treatmentEvidenceId')<>json_extract(original.body,'$.invoice.treatmentEvidenceId')
      AND EXISTS(SELECT 1 FROM acc_regime_events before JOIN acc_regime_events current
        ON current.company_id=before.company_id AND current.axis=before.axis AND current.value=before.value
        WHERE before.company_id=p.company_id AND before.axis='vat'
          AND before.id=json_extract(original.body,'$.invoice.registrationIds[0]')
          AND current.id=json_extract(p.body,'$.invoice.registrationIds[0]'))
      AND NOT EXISTS(SELECT 1 FROM acc_deferral_cancellations cancelled
        JOIN acc_journals cj ON cj.company_id=cancelled.company_id AND cj.id=cancelled.journal_id
        JOIN acc_proposals cp ON cp.company_id=cj.company_id AND cp.id=cj.source_id
        WHERE cancelled.company_id=parent.company_id AND cancelled.deferral_id=parent.deferral_id AND cj.date<=NEW.date
          AND json_extract(cp.body,'$.invoice.deferralCredit.schemaVersion')=1)
  ) THEN RAISE(ABORT,'invalid_deferral_supplement') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_supplement_insert BEFORE INSERT ON acc_deferral_supplements BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM acc_deferral_postings d JOIN acc_proposals p ON p.company_id=d.company_id AND p.id=d.deferral_id
    WHERE d.company_id=NEW.company_id AND d.deferral_id=NEW.deferral_id
      AND json_type(p.body,'$.invoice.deferral.supplement')='object'
      AND json_extract(p.body,'$.invoice.deferral.supplement.parentDeferralId')=NEW.parent_deferral_id
      AND d.created_by=NEW.created_by AND d.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_deferral_supplement_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_deferral_supplement AFTER INSERT ON acc_deferral_postings BEGIN
  INSERT INTO acc_deferral_supplements(company_id,deferral_id,parent_deferral_id,created_by,created_at)
  SELECT NEW.company_id,NEW.deferral_id,json_extract(p.body,'$.invoice.deferral.supplement.parentDeferralId'),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.deferral_id
    AND json_type(p.body,'$.invoice.deferral.supplement')='object';
END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_supplement_update BEFORE UPDATE ON acc_deferral_supplements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_deferral_supplement_delete BEFORE DELETE ON acc_deferral_supplements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
