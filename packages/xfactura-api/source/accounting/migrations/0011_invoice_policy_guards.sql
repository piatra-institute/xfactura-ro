-- Drizzle custom migration: immutable imported documents and approved policy versions.
CREATE TRIGGER acc_invoice_update BEFORE UPDATE ON acc_invoice_documents BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_invoice_delete BEFORE DELETE ON acc_invoice_documents BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_policy_update BEFORE UPDATE ON acc_accounting_policies BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_policy_delete BEFORE DELETE ON acc_accounting_policies BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_invoice_posting BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.invoice') IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents i ON i.company_id=p.company_id AND i.id=json_extract(p.body,'$.invoice.invoiceId')
      WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND i.hash=json_extract(p.body,'$.invoice.invoiceHash')
        AND i.direction=json_extract(p.body,'$.purpose') AND i.direction=json_extract(p.body,'$.invoice.direction')
        AND i.evidence_id=NEW.evidence_id AND json_extract(p.body,'$.sourceReference')='invoice:'||i.id
        AND EXISTS(SELECT 1 FROM acc_evidence e WHERE e.company_id=p.company_id AND e.id=json_extract(p.body,'$.invoice.treatmentEvidenceId')))
    THEN RAISE(ABORT,'invalid_invoice_interpretation') END;
END;
