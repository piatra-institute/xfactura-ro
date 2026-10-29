-- Drizzle generated this custom shell; the ordinary schema is unchanged.
-- Extend the unsupported SQLite price guard without editing applied 0050 or legacy records.
DROP TRIGGER acc_guard_document_allowance;
--> statement-breakpoint
CREATE TRIGGER acc_guard_document_allowance BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND (json_type(p.body,'$.invoice.documentAllowance') IS NOT NULL OR json_type(p.body,'$.invoice.documentCharge') IS NOT NULL
        OR (json_extract(d.body,'$.documentType')='invoice' AND (CAST(replace(json_extract(d.body,'$.totals.allowances'),'.','') AS INTEGER)>0 OR CAST(replace(json_extract(d.body,'$.totals.charges'),'.','') AS INTEGER)>0)))
  ) AND NOT EXISTS(
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(d.body,'$.parserVersion')='ubl-invoice-3' AND json_extract(d.body,'$.documentType')='invoice'
      AND coalesce(json_extract(d.body,'$.invoiceTypeCode'),'380')='380'
      AND json_extract(d.body,'$.currency')='RON'
      AND json_extract(d.body,'$.supplier.country')='RO' AND json_extract(d.body,'$.customer.country')='RO'
      AND json_array_length(d.body,'$.taxes')=1
      AND json_extract(d.body,'$.taxes[0].category') IN('S','O')
      AND json_extract(d.body,'$.totals.prepaid')='0.00' AND json_extract(d.body,'$.totals.rounding')='0.00'
      AND (CAST(replace(json_extract(d.body,'$.totals.allowances'),'.','') AS INTEGER)>0 OR CAST(replace(json_extract(d.body,'$.totals.charges'),'.','') AS INTEGER)>0)
      AND CAST(replace(json_extract(d.body,'$.totals.net'),'.','') AS INTEGER)>0
      AND json_array_length(d.body,'$.documentAdjustments') BETWEEN 1 AND 100
      AND NOT EXISTS(SELECT 1 FROM json_each(d.body,'$.documentAdjustments') a WHERE (json_extract(a.value,'$.charge') IS NOT 0 AND json_extract(a.value,'$.charge') IS NOT 1)
        OR CAST(replace(json_extract(a.value,'$.amount'),'.','') AS INTEGER)<=0
        OR json_extract(a.value,'$.vatCategory') IS NOT json_extract(d.body,'$.taxes[0].category')
        OR coalesce(json_extract(a.value,'$.vatRate'),'0')<>coalesce(json_extract(d.body,'$.taxes[0].rate'),'0'))
      AND coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(d.body,'$.documentAdjustments') a WHERE json_extract(a.value,'$.charge')=0),0)=CAST(replace(json_extract(d.body,'$.totals.allowances'),'.','') AS INTEGER)
      AND coalesce((SELECT sum(CAST(replace(json_extract(a.value,'$.amount'),'.','') AS INTEGER)) FROM json_each(d.body,'$.documentAdjustments') a WHERE json_extract(a.value,'$.charge')=1),0)=CAST(replace(json_extract(d.body,'$.totals.charges'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(d.body,'$.totals.lineNet'),'.','') AS INTEGER)-CAST(replace(json_extract(d.body,'$.totals.allowances'),'.','') AS INTEGER)+CAST(replace(json_extract(d.body,'$.totals.charges'),'.','') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.net'),'.','') AS INTEGER)
      AND ((json_extract(d.body,'$.totals.allowances')='0.00' AND json_type(p.body,'$.invoice.documentAllowance') IS NULL)
        OR (CAST(replace(json_extract(d.body,'$.totals.allowances'),'.','') AS INTEGER)>0
          AND json_extract(p.body,'$.invoice.documentAllowance.schemaVersion')=1
          AND json_extract(p.body,'$.invoice.documentAllowance.kind')='commercial_price_reduction'
          AND json_extract(p.body,'$.invoice.documentAllowance.lineNet')=json_extract(d.body,'$.totals.lineNet')
          AND json_extract(p.body,'$.invoice.documentAllowance.total')=json_extract(d.body,'$.totals.allowances')
          AND json_extract(p.body,'$.invoice.documentAllowance.net')=json_extract(d.body,'$.totals.net')))
      AND ((json_extract(d.body,'$.totals.charges')='0.00' AND json_type(p.body,'$.invoice.documentCharge') IS NULL)
        OR (CAST(replace(json_extract(d.body,'$.totals.charges'),'.','') AS INTEGER)>0
          AND json_extract(p.body,'$.invoice.documentCharge.schemaVersion')=1
          AND json_extract(p.body,'$.invoice.documentCharge.kind')='service_price_component'
          AND json_extract(p.body,'$.invoice.documentCharge.lineNet')=json_extract(d.body,'$.totals.lineNet')
          AND json_extract(p.body,'$.invoice.documentCharge.allowances')=json_extract(d.body,'$.totals.allowances')
          AND json_extract(p.body,'$.invoice.documentCharge.total')=json_extract(d.body,'$.totals.charges')
          AND json_extract(p.body,'$.invoice.documentCharge.net')=json_extract(d.body,'$.totals.net')
          AND json_array_length(p.body,'$.invoice.documentCharge.items')=(SELECT count(*) FROM json_each(d.body,'$.documentAdjustments') a WHERE json_extract(a.value,'$.charge')=1)
          AND (SELECT count(DISTINCT json_extract(item.value,'$.sourceIndex')) FROM json_each(p.body,'$.invoice.documentCharge.items') item)=json_array_length(p.body,'$.invoice.documentCharge.items')
          AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.invoice.documentCharge.items') item WHERE NOT EXISTS(
            SELECT 1 FROM json_each(d.body,'$.documentAdjustments') a WHERE a.key=json_extract(item.value,'$.sourceIndex') AND json_extract(a.value,'$.charge')=1
              AND json_extract(item.value,'$.amount')=json_extract(a.value,'$.amount')
              AND json_extract(item.value,'$.reason') IS json_extract(a.value,'$.reason')
              AND json_extract(item.value,'$.reasonCode') IS json_extract(a.value,'$.reasonCode')
          ))))
      AND json_extract(p.body,'$.invoice.net')=json_extract(d.body,'$.totals.net')
      AND json_extract(p.body,'$.invoice.tax')=json_extract(d.body,'$.totals.tax')
      AND json_extract(p.body,'$.invoice.gross')=json_extract(d.body,'$.totals.gross')
      AND json_type(p.body,'$.invoice.credit') IS NULL AND json_type(p.body,'$.invoice.accrualMatch') IS NULL
      AND json_type(p.body,'$.invoice.unbilledSaleMatch') IS NULL AND json_type(p.body,'$.invoice.deferral') IS NULL
      AND json_type(p.body,'$.invoice.deferralCredit') IS NULL AND json_type(p.body,'$.invoice.deferralDiscount') IS NULL
      AND json_type(p.body,'$.invoice.advance') IS NULL AND json_type(p.body,'$.invoice.advanceFinal') IS NULL AND json_type(p.body,'$.invoice.advanceCredit') IS NULL
      AND ((d.direction='purchase' AND (json_extract(p.body,'$.invoice.account')='628' OR json_extract(p.body,'$.invoice.account') LIKE '628.%')
        AND json_extract(p.body,'$.invoice.deduction') IN('full','none')
        AND (json_extract(p.body,'$.invoice.deduction')='none' OR json_extract(d.body,'$.taxes[0].category')='S'))
        OR (d.direction='sale' AND (json_extract(p.body,'$.invoice.account')='704' OR json_extract(p.body,'$.invoice.account') LIKE '704.%') AND json_extract(p.body,'$.invoice.deduction')='none'))
      AND json_extract(p.body,'$.invoice.deductibleTax')=CASE WHEN d.direction='purchase' AND json_extract(p.body,'$.invoice.deduction')='full' THEN json_extract(d.body,'$.totals.tax') ELSE '0.00' END
      AND json_array_length(NEW.lines_json)=2+CASE WHEN (d.direction='sale' AND json_extract(d.body,'$.totals.tax')<>'0.00') OR (d.direction='purchase' AND json_extract(p.body,'$.invoice.deductibleTax')<>'0.00') THEN 1 ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.lines_json) l WHERE NOT(
        (d.direction='purchase' AND (
          (json_extract(l.value,'$.account')=json_extract(p.body,'$.invoice.account') AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=0)
          OR (json_extract(l.value,'$.account')='401' AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=0)
          OR (json_extract(l.value,'$.account')='4426' AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=CAST(replace(json_extract(p.body,'$.invoice.deductibleTax'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=0)))
        OR (d.direction='sale' AND (
          (json_extract(l.value,'$.account')='4111' AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.gross'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=0)
          OR (json_extract(l.value,'$.account')=json_extract(p.body,'$.invoice.account') AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.net'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=0)
          OR (json_extract(l.value,'$.account')='4427' AND CAST(json_extract(l.value,'$.creditBani') AS INTEGER)=CAST(replace(json_extract(d.body,'$.totals.tax'),'.','') AS INTEGER) AND CAST(json_extract(l.value,'$.debitBani') AS INTEGER)=0)))
      ))
  ) THEN RAISE(ABORT,'invalid_document_allowance') END;
END;
