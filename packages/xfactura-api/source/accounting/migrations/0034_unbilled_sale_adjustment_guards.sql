-- Custom SQLite invariants only. The table, indexes, checks and FKs are generated in 0033.
DROP TRIGGER acc_guard_general_origins;
--> statement-breakpoint
CREATE TRIGGER acc_guard_general_origins BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND ((SELECT count(*) FROM json_each(p.body) x WHERE x.key IN ('invoice','settlement','accrual','unbilledSale','accrualAdjustment','unbilledSaleAdjustment','deferralRelease','advancePayment','advanceRefund') AND x.type='object')>1
        OR (CASE WHEN json_type(p.body,'$.invoice.credit')='object' THEN 1 ELSE 0 END)
          +(CASE WHEN json_type(p.body,'$.invoice.accrualMatch')='object' THEN 1 ELSE 0 END)
          +(CASE WHEN json_type(p.body,'$.invoice.unbilledSaleMatch')='object' THEN 1 ELSE 0 END)>1)
  ) THEN RAISE(ABORT,'multiple_general_origins') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_unbilled_sale_adjustment BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.unbilledSaleAdjustment')='object') AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_unbilled_sale_postings s ON s.company_id=p.company_id AND s.unbilled_sale_id=json_extract(p.body,'$.unbilledSaleAdjustment.unbilledSaleId')
    JOIN acc_proposals original ON original.company_id=s.company_id AND original.id=s.unbilled_sale_id
    JOIN acc_journals j ON j.company_id=s.company_id AND j.id=s.journal_id
    JOIN acc_evidence e ON e.company_id=p.company_id AND e.id=NEW.evidence_id
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(original.body,'$.unbilledSale.measurementBasis')='estimated_consideration'
      AND json_extract(p.body,'$.purpose')='adjustment'
      AND json_extract(p.body,'$.unbilledSaleAdjustment.schemaVersion')=1
      AND json_extract(p.body,'$.unbilledSaleAdjustment.periodBasis')='current_year_estimate_change'
      AND json_extract(p.body,'$.unbilledSaleAdjustment.changeBasis')='new_measurement_information'
      AND json_extract(original.body,'$.financialYearId')=json_extract(p.body,'$.financialYearId')
      AND j.id=json_extract(p.body,'$.unbilledSaleAdjustment.originalJournalId')
      AND original.hash=json_extract(p.body,'$.unbilledSaleAdjustment.originalProposalHash')
      AND json_extract(original.body,'$.financialYearId')=json_extract(p.body,'$.unbilledSaleAdjustment.originalFinancialYearId')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.date')=NEW.date AND j.date<=NEW.date
      AND json_extract(p.body,'$.unbilledSaleAdjustment.evidenceId')=NEW.evidence_id
      AND json_extract(p.body,'$.unbilledSaleAdjustment.sourceHash')=e.hash
      AND json_extract(original.body,'$.unbilledSale.evidenceId')<>e.id
      AND NOT EXISTS(SELECT 1 FROM acc_invoice_documents i WHERE i.company_id=p.company_id AND i.evidence_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM acc_unbilled_sale_adjustments d JOIN acc_proposals dp ON dp.company_id=d.company_id AND dp.id=d.proposal_id WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id AND json_extract(dp.body,'$.unbilledSaleAdjustment.evidenceId')=e.id)
      AND json_extract(p.body,'$.sourceReference')='unbilled-sale-adjustment:'||json_extract(p.body,'$.unbilledSaleAdjustment.reference')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.serviceReference')=json_extract(original.body,'$.unbilledSale.reference')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.evidenceDate')<=json_extract(p.body,'$.unbilledSaleAdjustment.newInformationDate')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.newInformationDate') BETWEEN j.date AND NEW.date
      AND substr(json_extract(p.body,'$.unbilledSaleAdjustment.newInformationDate'),1,7)=substr(NEW.date,1,7)
      AND json_extract(p.body,'$.unbilledSaleAdjustment.previousJournalId')=coalesce((SELECT d.journal_id FROM acc_unbilled_sale_adjustments d JOIN acc_journals dj ON dj.company_id=d.company_id AND dj.id=d.journal_id WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id ORDER BY dj.number DESC LIMIT 1),j.id)
      AND json_extract(p.body,'$.correctsJournalId')=json_extract(p.body,'$.unbilledSaleAdjustment.previousJournalId')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.positionVersion')=(SELECT count(*) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=s.unbilled_sale_id)+(SELECT count(*) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id)
      AND NOT EXISTS(SELECT 1 FROM acc_unbilled_sale_adjustments d JOIN acc_journals dj ON dj.company_id=d.company_id AND dj.id=d.journal_id WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id AND dj.date>NEW.date)
      AND NOT EXISTS(SELECT 1 FROM acc_unbilled_sale_matches m JOIN acc_invoice_postings ip ON ip.company_id=m.company_id AND ip.invoice_id=m.invoice_id JOIN acc_journals mj ON mj.company_id=ip.company_id AND mj.id=ip.journal_id WHERE m.company_id=p.company_id AND m.unbilled_sale_id=s.unbilled_sale_id AND mj.date>NEW.date)
      AND json_extract(p.body,'$.unbilledSaleAdjustment.account')=json_extract(original.body,'$.unbilledSale.account')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.taxPointDate')=json_extract(original.body,'$.unbilledSale.taxPointDate')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.rate')=json_extract(original.body,'$.unbilledSale.rate')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.rate') IN ('0','19','21')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.ruleId')=json_extract(original.body,'$.unbilledSale.ruleId')
      AND json_extract(p.body,'$.unbilledSaleAdjustment.ruleHash')=json_extract(original.body,'$.unbilledSale.ruleHash')
      AND ((json_extract(original.body,'$.unbilledSale.vatCategory')='O' AND json_extract(p.body,'$.unbilledSaleAdjustment.taxTreatment')='non_vat') OR (json_extract(original.body,'$.unbilledSale.vatCategory')='S' AND json_extract(p.body,'$.unbilledSaleAdjustment.taxTreatment')='same_service_month' AND substr(NEW.date,1,7)=substr(json_extract(original.body,'$.unbilledSale.taxPointDate'),1,7)))
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.net'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.unbilledSale.net'),'.','') AS INTEGER)+coalesce((SELECT sum(d.net_bani) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id),0)-coalesce((SELECT sum(m.net_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=s.unbilled_sale_id),0)
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.tax'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.unbilledSale.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(d.tax_bani) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id),0)-coalesce((SELECT sum(m.tax_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=s.unbilled_sale_id),0)
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.gross'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.unbilledSale.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(d.gross_bani) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=s.unbilled_sale_id),0)-coalesce((SELECT sum(m.gross_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=s.unbilled_sale_id),0)
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.gross'),'.','') AS INTEGER)>0
      AND json_extract(p.body,'$.unbilledSaleAdjustment.remainingNet')=json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net')
      AND ((json_extract(p.body,'$.unbilledSaleAdjustment.action')='release' AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net'),'.','') AS INTEGER)=0) OR (json_extract(p.body,'$.unbilledSaleAdjustment.action')='reestimate' AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net'),'.','') AS INTEGER)>0))
      AND json_type(p.body,'$.unbilledSaleAdjustment.remaining')='object' AND (SELECT count(*) FROM json_each(p.body,'$.unbilledSaleAdjustment.remaining'))=3
      AND json_type(p.body,'$.unbilledSaleAdjustment.delta')='object' AND (SELECT count(*) FROM json_each(p.body,'$.unbilledSaleAdjustment.delta'))=3
      AND NOT EXISTS(SELECT 1 FROM json_each(p.body,'$.unbilledSaleAdjustment.remaining') r WHERE CAST(replace(r.value,'.','') AS INTEGER)<0)
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.gross'),'.','') AS INTEGER)=CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net'),'.','') AS INTEGER)+CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.tax'),'.','') AS INTEGER)
      -- Integer decomposition avoids overflow from multiplying a large bani amount by its rate.
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.tax'),'.','') AS INTEGER)=(CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net'),'.','') AS INTEGER)/100)*CAST(json_extract(p.body,'$.unbilledSaleAdjustment.rate') AS INTEGER)+((CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net'),'.','') AS INTEGER)%100)*CAST(json_extract(p.body,'$.unbilledSaleAdjustment.rate') AS INTEGER)+50)/100
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.net'),'.','') AS INTEGER)=CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.net'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.net'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.tax'),'.','') AS INTEGER)=CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.tax'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.tax'),'.','') AS INTEGER)
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.gross'),'.','') AS INTEGER)=CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.remaining.gross'),'.','') AS INTEGER)-CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.previousRemaining.gross'),'.','') AS INTEGER)
      AND (CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.net'),'.','') AS INTEGER)<>0 OR CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.tax'),'.','') AS INTEGER)<>0)
      AND NEW.lines_json=(SELECT json_group_array(json_object('account',account,'debitBani',CAST(max(amount,0) AS TEXT),'creditBani',CAST(max(-amount,0) AS TEXT))) FROM (
        SELECT 1 AS ordinal,'418' AS account,CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.gross'),'.','') AS INTEGER) AS amount
        UNION ALL SELECT 2,json_extract(original.body,'$.unbilledSale.account'),-CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.net'),'.','') AS INTEGER)
        UNION ALL SELECT 3,'4427',-CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.tax'),'.','') AS INTEGER)
      ) WHERE amount<>0 ORDER BY ordinal)
  ) THEN RAISE(ABORT,'stale_or_invalid_unbilled_sale_adjustment') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_adjustment_insert BEFORE INSERT ON acc_unbilled_sale_adjustments BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM acc_journals j JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id AND j.kind='general' AND p.id=NEW.proposal_id
      AND json_extract(p.body,'$.unbilledSaleAdjustment.unbilledSaleId')=NEW.unbilled_sale_id
      AND json_extract(p.body,'$.unbilledSaleAdjustment.reference')=NEW.reference
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.net'),'.','') AS INTEGER)=NEW.net_bani
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.tax'),'.','') AS INTEGER)=NEW.tax_bani
      AND CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.gross'),'.','') AS INTEGER)=NEW.gross_bani
      AND j.created_by=NEW.created_by AND j.created_at=NEW.created_at
  ) THEN RAISE(ABORT,'invalid_unbilled_sale_adjustment_projection') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_record_unbilled_sale_adjustment AFTER INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  INSERT INTO acc_unbilled_sale_adjustments(company_id,proposal_id,unbilled_sale_id,journal_id,reference,net_bani,tax_bani,gross_bani,created_by,created_at)
  SELECT NEW.company_id,p.id,json_extract(p.body,'$.unbilledSaleAdjustment.unbilledSaleId'),NEW.id,json_extract(p.body,'$.unbilledSaleAdjustment.reference'),
    CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.net'),'.','') AS INTEGER),
    CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.tax'),'.','') AS INTEGER),
    CAST(replace(json_extract(p.body,'$.unbilledSaleAdjustment.delta.gross'),'.','') AS INTEGER),NEW.created_by,NEW.created_at
  FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_type(p.body,'$.unbilledSaleAdjustment')='object';
END;
--> statement-breakpoint
DROP TRIGGER acc_guard_unbilled_sale_match;
--> statement-breakpoint
CREATE TRIGGER acc_guard_unbilled_sale_match BEFORE INSERT ON acc_journals
WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_type(p.body,'$.invoice.unbilledSaleMatch')='object'
  ) AND NOT EXISTS (
    SELECT 1 FROM acc_proposals p JOIN acc_invoice_documents d ON d.company_id=p.company_id AND d.id=json_extract(p.body,'$.invoice.invoiceId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND json_extract(p.body,'$.purpose')='sale' AND json_extract(p.body,'$.invoice.direction')='sale'
      AND json_extract(d.body,'$.issueDate')=NEW.date
      AND json_array_length(p.body,'$.invoice.unbilledSaleMatch.allocations') BETWEEN 1 AND 100
      AND (SELECT sum(CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a)=CAST(replace(json_extract(p.body,'$.invoice.net'),'.','') AS INTEGER)
      AND (SELECT sum(CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)) FROM json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a)=CAST(replace(json_extract(p.body,'$.invoice.tax'),'.','') AS INTEGER)
      AND NEW.lines_json=json_array(
        json_object('account','4111','debitBani',CAST(CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) AS TEXT),'creditBani','0'),
        json_object('account','418','debitBani','0','creditBani',CAST(CAST(replace(json_extract(p.body,'$.invoice.gross'),'.','') AS INTEGER) AS TEXT)))
  ) THEN RAISE(ABORT,'invalid_unbilled_sale_match_origin') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_proposals p JOIN json_each(p.body,'$.invoice.unbilledSaleMatch.allocations') a
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND NOT EXISTS (
      SELECT 1 FROM acc_unbilled_sale_postings ap
      JOIN acc_proposals original ON original.company_id=ap.company_id AND original.id=ap.unbilled_sale_id
      JOIN acc_journals j ON j.company_id=ap.company_id AND j.id=ap.journal_id
      WHERE ap.company_id=p.company_id AND ap.unbilled_sale_id=json_extract(a.value,'$.unbilledSaleId')
        AND j.id=json_extract(a.value,'$.originalJournalId') AND j.date<=NEW.date
        AND original.hash=json_extract(a.value,'$.proposalHash')
        AND json_extract(a.value,'$.latestAdjustmentJournalId') IS (SELECT d.journal_id FROM acc_unbilled_sale_adjustments d JOIN acc_journals dj ON dj.company_id=d.company_id AND dj.id=d.journal_id WHERE d.company_id=p.company_id AND d.unbilled_sale_id=ap.unbilled_sale_id ORDER BY dj.number DESC LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM acc_unbilled_sale_adjustments d JOIN acc_journals dj ON dj.company_id=d.company_id AND dj.id=d.journal_id WHERE d.company_id=p.company_id AND d.unbilled_sale_id=ap.unbilled_sale_id AND dj.date>NEW.date)
        AND NOT EXISTS(SELECT 1 FROM acc_unbilled_sale_matches m JOIN acc_invoice_postings ip ON ip.company_id=m.company_id AND ip.invoice_id=m.invoice_id JOIN acc_journals mj ON mj.company_id=ip.company_id AND mj.id=ip.journal_id WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id AND mj.date>NEW.date)
        AND json_extract(original.body,'$.financialYearId')=json_extract(a.value,'$.originalFinancialYearId')
        AND json_extract(a.value,'$.positionVersion')=(SELECT count(*) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id)+(SELECT count(*) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=ap.unbilled_sale_id)
        AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)>0
        AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)>=0
        AND CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)=CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)+CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.net'),'.','') AS INTEGER)+coalesce((SELECT sum(m.net_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id),0)<=CAST(replace(json_extract(original.body,'$.unbilledSale.net'),'.','') AS INTEGER)+coalesce((SELECT sum(d.net_bani) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=ap.unbilled_sale_id),0)
        AND CAST(replace(json_extract(a.value,'$.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(m.tax_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id),0)<=CAST(replace(json_extract(original.body,'$.unbilledSale.tax'),'.','') AS INTEGER)+coalesce((SELECT sum(d.tax_bani) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=ap.unbilled_sale_id),0)
        AND CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)=CAST(replace(json_extract(original.body,'$.unbilledSale.gross'),'.','') AS INTEGER)+coalesce((SELECT sum(d.gross_bani) FROM acc_unbilled_sale_adjustments d WHERE d.company_id=p.company_id AND d.unbilled_sale_id=ap.unbilled_sale_id),0)-coalesce((SELECT sum(m.gross_bani) FROM acc_unbilled_sale_matches m WHERE m.company_id=p.company_id AND m.unbilled_sale_id=ap.unbilled_sale_id),0)
        AND CAST(replace(json_extract(a.value,'$.remainingGross'),'.','') AS INTEGER)=CAST(replace(json_extract(a.value,'$.availableGross'),'.','') AS INTEGER)-CAST(replace(json_extract(a.value,'$.gross'),'.','') AS INTEGER)
        AND CAST(replace(json_extract(a.value,'$.remainingGross'),'.','') AS INTEGER)>=0
    )
  ) THEN RAISE(ABORT,'stale_or_excessive_unbilled_sale_match') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_adjustment_update BEFORE UPDATE ON acc_unbilled_sale_adjustments BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_unbilled_sale_adjustment_delete BEFORE DELETE ON acc_unbilled_sale_adjustments BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
