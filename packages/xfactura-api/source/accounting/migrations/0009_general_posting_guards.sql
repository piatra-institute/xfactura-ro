-- Drizzle custom migration: general-ledger, interval and immutable-record invariants.
DROP TRIGGER IF EXISTS acc_guard_journal;
--> statement-breakpoint
CREATE TRIGGER acc_guard_journal BEFORE INSERT ON acc_journals BEGIN
  SELECT CASE WHEN NEW.kind NOT IN ('opening','purchase','payment','correction','general') THEN RAISE(ABORT,'unsupported_journal_kind') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_periods WHERE company_id=NEW.company_id AND month=substr(NEW.date,1,7)||'-01' AND closed_at IS NOT NULL) THEN RAISE(ABORT,'closed_period') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_accounting_years WHERE company_id=NEW.company_id AND kind='financial' AND NEW.date BETWEEN date_from AND date_to) THEN RAISE(ABORT,'outside_financial_year') END;
  SELECT CASE WHEN NEW.kind<>'payment' AND NOT EXISTS(
    SELECT 1 FROM acc_approvals a JOIN acc_proposals p ON p.company_id=a.company_id AND p.id=a.proposal_id
    WHERE a.company_id=NEW.company_id AND a.id=NEW.approval_id AND p.id=NEW.source_id
      AND a.version=p.version AND a.hash=p.hash AND p.kind=NEW.kind
      AND json_extract(p.body,'$.date')=NEW.date AND json_extract(p.body,'$.evidenceId')=NEW.evidence_id
  ) THEN RAISE(ABORT,'stale_or_missing_approval') END;
  SELECT CASE WHEN json_type(NEW.lines_json) IS NOT 'array' OR json_array_length(NEW.lines_json) NOT BETWEEN 2 AND 2000 THEN RAISE(ABORT,'invalid_posting_lines') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.lines_json) WHERE
    json_type(value,'$.debitBani') IS NOT 'text' OR json_type(value,'$.creditBani') IS NOT 'text'
    OR json_extract(value,'$.debitBani') GLOB '*[^0-9]*' OR json_extract(value,'$.creditBani') GLOB '*[^0-9]*'
    OR length(json_extract(value,'$.debitBani')) NOT BETWEEN 1 AND 18 OR length(json_extract(value,'$.creditBani')) NOT BETWEEN 1 AND 18
  ) THEN RAISE(ABORT,'invalid_integer_amount') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.lines_json) line WHERE NOT EXISTS(
    SELECT 1 FROM acc_ledger_accounts a WHERE a.company_id=NEW.company_id AND a.code=json_extract(line.value,'$.account')
      AND a.postable=1 AND a.book='general' AND a.valid_from<=NEW.date
  )) THEN RAISE(ABORT,'invalid_ledger_account') END;
  SELECT CASE WHEN (SELECT sum(CAST(json_extract(value,'$.debitBani') AS INTEGER)-CAST(json_extract(value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json))<>0 THEN RAISE(ABORT,'unbalanced_journal') END;
  SELECT CASE WHEN NEW.kind IN ('opening','purchase') AND NEW.lines_json<>(
    SELECT json_array(
      json_object('account',CASE NEW.kind WHEN 'opening' THEN '5121' ELSE '628' END,'debitBani',CAST(CAST(replace(json_extract(body,'$.amount'),'.','') AS INTEGER) AS TEXT),'creditBani','0'),
      json_object('account',CASE NEW.kind WHEN 'opening' THEN '1012' ELSE '401' END,'debitBani','0','creditBani',CAST(CAST(replace(json_extract(body,'$.amount'),'.','') AS INTEGER) AS TEXT)))
    FROM acc_proposals WHERE company_id=NEW.company_id AND id=NEW.source_id
  ) THEN RAISE(ABORT,'legacy_lines_differ_from_approval') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_unique_opening BEFORE INSERT ON acc_journals WHEN NEW.kind='opening' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_journals j LEFT JOIN acc_proposals p ON p.company_id=j.company_id AND p.id=j.source_id
    WHERE j.company_id=NEW.company_id AND j.date=NEW.date AND (j.kind='opening' OR (j.kind='general' AND json_extract(p.body,'$.purpose')='opening')))
    THEN RAISE(ABORT,'duplicate_or_invalid_opening') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_general_journal BEFORE INSERT ON acc_journals WHEN NEW.kind='general' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_proposals p JOIN acc_accounting_years y ON y.company_id=p.company_id AND y.id=json_extract(p.body,'$.financialYearId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND p.kind='general' AND json_extract(p.body,'$.schemaVersion')=2
      AND y.kind='financial' AND NEW.date BETWEEN y.date_from AND y.date_to
      AND NEW.description=json_extract(p.body,'$.description')
      AND NEW.lines_json=(SELECT json_group_array(json_object('account',json_extract(value,'$.account'),
        'debitBani',CAST(CAST(replace(json_extract(value,'$.debit'),'.','') AS INTEGER) AS TEXT),
        'creditBani',CAST(CAST(replace(json_extract(value,'$.credit'),'.','') AS INTEGER) AS TEXT))) FROM json_each(p.body,'$.lines'))
  ) THEN RAISE(ABORT,'general_lines_differ_from_approval') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND json_extract(p.body,'$.purpose')='opening'
    AND (NEW.date<>(SELECT date_from FROM acc_accounting_years WHERE company_id=NEW.company_id AND id=json_extract(p.body,'$.financialYearId'))
      OR EXISTS(SELECT 1 FROM acc_journals j LEFT JOIN acc_proposals prior ON prior.company_id=j.company_id AND prior.id=j.source_id
        WHERE j.company_id=NEW.company_id AND j.date=NEW.date AND (j.kind='opening' OR (j.kind='general' AND json_extract(prior.body,'$.purpose')='opening')))))
    THEN RAISE(ABORT,'duplicate_or_invalid_opening') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_normalize_journal AFTER INSERT ON acc_journals BEGIN
  INSERT INTO acc_journal_lines(company_id,journal_id,line,account,debit_bani,credit_bani)
  SELECT NEW.company_id,NEW.id,CAST(key AS INTEGER)+1,json_extract(value,'$.account'),CAST(json_extract(value,'$.debitBani') AS INTEGER),CAST(json_extract(value,'$.creditBani') AS INTEGER) FROM json_each(NEW.lines_json);
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_line BEFORE INSERT ON acc_journal_lines BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM acc_journals j WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id
    AND json_extract(j.lines_json,'$['||(NEW.line-1)||'].account')=NEW.account
    AND CAST(json_extract(j.lines_json,'$['||(NEW.line-1)||'].debitBani') AS INTEGER)=NEW.debit_bani
    AND CAST(json_extract(j.lines_json,'$['||(NEW.line-1)||'].creditBani') AS INTEGER)=NEW.credit_bani
  ) THEN RAISE(ABORT,'immutable_posted_lines') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_journal_lines_update BEFORE UPDATE ON acc_journal_lines BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_journal_lines_delete BEFORE DELETE ON acc_journal_lines BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_year_overlap BEFORE INSERT ON acc_accounting_years BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_accounting_years y WHERE y.company_id=NEW.company_id AND y.kind=NEW.kind
    AND NEW.date_from<=y.date_to AND NEW.date_to>=y.date_from AND NOT(NEW.date_from=y.date_from AND NEW.date_to=y.date_to)) THEN RAISE(ABORT,'overlapping_accounting_years') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_year_update BEFORE UPDATE ON acc_accounting_years BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_year_delete BEFORE DELETE ON acc_accounting_years BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_account_update BEFORE UPDATE ON acc_ledger_accounts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_account_delete BEFORE DELETE ON acc_ledger_accounts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_regime_update BEFORE UPDATE ON acc_regime_events BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_regime_delete BEFORE DELETE ON acc_regime_events BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
