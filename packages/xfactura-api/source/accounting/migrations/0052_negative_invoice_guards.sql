-- Drizzle generated this custom shell; there is no ordinary schema change.
-- Only unsupported SQLite source/credit invariants are defined explicitly here.
CREATE TRIGGER acc_guard_negative_invoice BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_extract(d.body,'$.documentType')='invoice'
      AND json_extract(d.body,'$.originalInvoiceNumber') IS NOT NULL
      AND json_type(p.body,'$.invoice.advanceFinal') IS NOT 'object' AND json_type(p.body,'$.invoice.deferral.supplement') IS NOT 'object'
  ) THEN RAISE(ABORT,'unsupported_invoice_reference') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND (json_type(p.body,'$.invoice.sourceCredit') IS NOT NULL OR json_type(d.body,'$.sourceInvoice') IS NOT NULL OR json_extract(d.body,'$.parserVersion')='ubl-invoice-4')
  ) AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    JOIN acc_invoice_documents original ON original.company_id=p.company_id AND original.id=json_extract(p.body,'$.invoice.credit.originalInvoiceId')
    JOIN acc_invoice_postings ip ON ip.company_id=original.company_id AND ip.invoice_id=original.id
    JOIN acc_proposals op ON op.company_id=ip.company_id AND op.id=ip.proposal_id
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(d.body,'$.parserVersion')='ubl-invoice-4' AND json_extract(d.body,'$.documentType')='credit_note'
      AND json_extract(d.body,'$.sourceInvoice.typeCode')='380' AND json_extract(d.body,'$.sourceInvoice.polarity')='negative'
      AND json_extract(d.body,'$.invoiceTypeCode')='380' AND json_extract(d.body,'$.currency')='RON'
      AND json_extract(d.body,'$.supplier.country')='RO' AND json_extract(d.body,'$.customer.country')='RO'
      AND json_extract(original.body,'$.documentType')='invoice' AND json_type(p.body,'$.invoice.credit')='object'
      AND d.direction=original.direction AND json_extract(original.body,'$.currency')='RON'
      AND NOT EXISTS(SELECT 1 FROM json_each(json_array(json_extract(d.body,'$.supplier'),json_extract(d.body,'$.customer'))) party
        JOIN json_each(json_array(json_extract(original.body,'$.supplier'),json_extract(original.body,'$.customer'))) base_party ON base_party.key=party.key
        WHERE (
          json_extract(party.value,'$.country') IS NOT json_extract(base_party.value,'$.country')
          OR CASE WHEN upper(substr(trim(json_extract(party.value,'$.taxId')),1,2))='RO' THEN substr(trim(json_extract(party.value,'$.taxId')),3) ELSE trim(json_extract(party.value,'$.taxId')) END
            IS NOT CASE WHEN upper(substr(trim(json_extract(base_party.value,'$.taxId')),1,2))='RO' THEN substr(trim(json_extract(base_party.value,'$.taxId')),3) ELSE trim(json_extract(base_party.value,'$.taxId')) END))
      AND json_array_length(d.body,'$.taxes')=1 AND json_array_length(original.body,'$.taxes')=1
      AND json_extract(d.body,'$.taxes[0].category')=json_extract(original.body,'$.taxes[0].category')
      AND coalesce(json_extract(d.body,'$.taxes[0].rate'),'0')=coalesce(json_extract(original.body,'$.taxes[0].rate'),'0')
      AND json_extract(p.body,'$.invoice.invoiceHash')=d.hash
      AND json_extract(p.body,'$.invoice.taxPointDate')=json_extract(op.body,'$.invoice.taxPointDate')
      AND json_extract(p.body,'$.invoice.credit.originalFinancialYearId')=json_extract(op.body,'$.financialYearId')
      AND json_extract(p.body,'$.purpose')=d.direction AND NEW.evidence_id=d.evidence_id
      AND json_extract(p.body,'$.sourceReference')='invoice:'||d.id
      AND json_extract(p.body,'$.invoice.credit.kind') IN ('cancellation','commercial_discount')
      AND json_extract(p.body,'$.invoice.credit.periodBasis')='current_period_event'
      AND json_extract(d.body,'$.issueDate')>=json_extract(original.body,'$.issueDate')
      AND json_extract(p.body,'$.invoice.credit.decisionDate')>=json_extract(original.body,'$.issueDate')
      AND json_extract(p.body,'$.invoice.credit.decisionDate')<=json_extract(d.body,'$.issueDate')
      AND json_extract(p.body,'$.invoice.credit.decisionDate')<=NEW.date
      AND substr(json_extract(p.body,'$.invoice.credit.decisionDate'),1,7)=substr(NEW.date,1,7)
      AND substr(json_extract(d.body,'$.issueDate'),1,7)=substr(NEW.date,1,7)
      AND json_array_length(d.body,'$.invoiceReferences')=1
      AND json_extract(d.body,'$.invoiceReferences[0].number')=json_extract(original.body,'$.number')
      AND json_extract(d.body,'$.invoiceReferences[0].issueDate')=json_extract(original.body,'$.issueDate')
      AND json_extract(d.body,'$.originalInvoiceNumber')=json_extract(original.body,'$.number')
      AND json_extract(d.body,'$.totals.allowances')='0.00' AND json_extract(d.body,'$.totals.charges')='0.00'
      AND json_extract(d.body,'$.totals.prepaid')='0.00' AND json_extract(d.body,'$.totals.rounding')='0.00'
      AND CAST(replace(json_extract(d.body,'$.totals.net'),'.','') AS INTEGER)>0
      AND json_array_length(d.body,'$.sourceInvoice.lines')=json_array_length(d.body,'$.lines')
      AND NOT EXISTS(SELECT 1 FROM json_each(d.body,'$.sourceInvoice.lines') s WHERE NOT EXISTS(
        SELECT 1 FROM json_each(d.body,'$.lines') l WHERE json_extract(l.value,'$.id')=json_extract(s.value,'$.lineId')
          AND CAST(replace(json_extract(l.value,'$.net'),'.','') AS INTEGER)>0
          AND CAST(json_extract(s.value,'$.quantity') AS NUMERIC)<0 AND CAST(json_extract(s.value,'$.unitPrice') AS NUMERIC)>0
          AND CAST(json_extract(s.value,'$.priceBaseQuantity') AS NUMERIC)>0
      ))
      AND json_extract(p.body,'$.invoice.sourceCredit.schemaVersion')=1 AND json_extract(p.body,'$.invoice.sourceCredit.typeCode')='380'
      AND CAST(replace(json_extract(p.body,'$.invoice.sourceCredit.net'),'.','') AS INTEGER)=-CAST(replace(json_extract(d.body,'$.totals.net'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.invoice.sourceCredit.tax'),'.','') AS INTEGER)=-CAST(replace(json_extract(d.body,'$.totals.tax'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.invoice.sourceCredit.gross'),'.','') AS INTEGER)=-CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER)
      AND json_extract(p.body,'$.invoice.net')=json_extract(d.body,'$.totals.net')
      AND json_extract(p.body,'$.invoice.tax')=json_extract(d.body,'$.totals.tax')
      AND json_extract(p.body,'$.invoice.gross')=json_extract(d.body,'$.totals.gross')
      AND json_extract(p.body,'$.invoice.deduction')=json_extract(op.body,'$.invoice.deduction')
      AND json_extract(p.body,'$.invoice.ruleHash')=json_extract(op.body,'$.invoice.ruleHash')
      AND json_extract(p.body,'$.invoice.deductibleTax')=CASE WHEN d.direction='purchase' AND json_extract(p.body,'$.invoice.deduction')='full' THEN json_extract(d.body,'$.totals.tax') ELSE '0.00' END
      AND (json_type(p.body,'$.invoice.deferralCredit')='object' OR json_type(p.body,'$.invoice.advanceCredit')='object' OR (
        json_extract(p.body,'$.invoice.account')=CASE WHEN json_extract(p.body,'$.invoice.credit.kind')='commercial_discount' THEN CASE WHEN d.direction='sale' THEN '709' ELSE '609' END ELSE json_extract(op.body,'$.invoice.account') END
        AND json_array_length(NEW.lines_json)=2+CASE WHEN (d.direction='sale' AND json_extract(d.body,'$.totals.tax')<>'0.00') OR (d.direction='purchase' AND json_extract(p.body,'$.invoice.deductibleTax')<>'0.00') THEN 1 ELSE 0 END
        AND NOT EXISTS(SELECT 1 FROM json_each(NEW.lines_json) l WHERE NOT(
          (d.direction='purchase' AND (
            (json_extract(l.value,'$.account')='401' AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=0)
            OR (json_extract(l.value,'$.account')=json_extract(p.body,'$.invoice.account') AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=0)
            OR (json_extract(l.value,'$.account')='4426' AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=0)))
          OR (d.direction='sale' AND (
            (json_extract(l.value,'$.account')='4111' AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=0)
            OR (json_extract(l.value,'$.account')=json_extract(p.body,'$.invoice.account') AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.net'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=0)
            OR (json_extract(l.value,'$.account')='4427' AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.tax'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=0)))
        ))
      ))
  ) THEN RAISE(ABORT,'invalid_negative_invoice_credit') END;
END;
