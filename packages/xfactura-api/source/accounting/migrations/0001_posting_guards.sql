-- Custom SQLite invariants not represented by Drizzle schema metadata.
CREATE TRIGGER acc_guard_journal BEFORE INSERT ON acc_journals BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_periods WHERE company_id=NEW.company_id AND month=substr(NEW.date,1,7)||'-01' AND closed_at IS NOT NULL) THEN RAISE(ABORT,'closed_period') END;
  SELECT CASE WHEN CAST(substr(NEW.date,1,4) AS INTEGER)<>(SELECT year FROM acc_companies WHERE id=NEW.company_id) THEN RAISE(ABORT,'outside_fiscal_year') END;
  SELECT CASE WHEN NEW.kind IN('opening','purchase') AND NOT EXISTS(
    SELECT 1 FROM acc_approvals a JOIN acc_proposals p ON p.company_id=a.company_id AND p.id=a.proposal_id
    WHERE a.company_id=NEW.company_id AND a.id=NEW.approval_id AND p.id=NEW.source_id AND a.version=p.version AND a.hash=p.hash
  ) THEN RAISE(ABORT,'stale_or_missing_approval') END;
  SELECT CASE WHEN json_type(NEW.lines_json)<>'array' OR json_array_length(NEW.lines_json)<2 OR json_array_length(NEW.lines_json)>100 THEN RAISE(ABORT,'invalid_posting_lines') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.lines_json) WHERE
    json_type(value,'$.debitBani')<>'text' OR json_type(value,'$.creditBani')<>'text'
    OR json_extract(value,'$.debitBani') GLOB '*[^0-9]*' OR json_extract(value,'$.creditBani') GLOB '*[^0-9]*'
    OR length(json_extract(value,'$.debitBani')) NOT BETWEEN 1 AND 18 OR length(json_extract(value,'$.creditBani')) NOT BETWEEN 1 AND 18
  ) THEN RAISE(ABORT,'invalid_integer_amount') END;
  SELECT CASE WHEN (SELECT sum(CAST(json_extract(value,'$.debitBani') AS INTEGER)-CAST(json_extract(value,'$.creditBani') AS INTEGER)) FROM json_each(NEW.lines_json))<>0 THEN RAISE(ABORT,'unbalanced_journal') END;
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
CREATE TRIGGER acc_guard_proposal BEFORE UPDATE ON acc_proposals BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM acc_journals WHERE company_id=OLD.company_id AND source_id=OLD.id AND kind=OLD.kind) THEN RAISE(ABORT,'posted_proposal') END;
  SELECT CASE WHEN NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.kind<>OLD.kind OR NEW.version<>OLD.version+1 THEN RAISE(ABORT,'invalid_revision') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_period BEFORE UPDATE ON acc_periods WHEN OLD.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'closed_period_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER acc_period_delete BEFORE DELETE ON acc_periods BEGIN SELECT RAISE(ABORT,'period_immutable'); END;

--> statement-breakpoint
CREATE TRIGGER acc_evidence_update BEFORE UPDATE ON acc_evidence BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_evidence_delete BEFORE DELETE ON acc_evidence BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_facts_update BEFORE UPDATE ON acc_facts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_facts_delete BEFORE DELETE ON acc_facts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_approvals_update BEFORE UPDATE ON acc_approvals BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_approvals_delete BEFORE DELETE ON acc_approvals BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_tax_positions_update BEFORE UPDATE ON acc_tax_positions BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_tax_positions_delete BEFORE DELETE ON acc_tax_positions BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_fiscal_interpretations_update BEFORE UPDATE ON acc_fiscal_interpretations BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_fiscal_interpretations_delete BEFORE DELETE ON acc_fiscal_interpretations BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_journals_update BEFORE UPDATE ON acc_journals BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_journals_delete BEFORE DELETE ON acc_journals BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_journal_lines_update BEFORE UPDATE ON acc_journal_lines BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_journal_lines_delete BEFORE DELETE ON acc_journal_lines BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_statements_update BEFORE UPDATE ON acc_statements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_statements_delete BEFORE DELETE ON acc_statements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_movements_update BEFORE UPDATE ON acc_movements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_movements_delete BEFORE DELETE ON acc_movements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_statement_movements_update BEFORE UPDATE ON acc_statement_movements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_statement_movements_delete BEFORE DELETE ON acc_statement_movements BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_allocations_update BEFORE UPDATE ON acc_allocations BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_allocations_delete BEFORE DELETE ON acc_allocations BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_commands_update BEFORE UPDATE ON acc_commands BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_commands_delete BEFORE DELETE ON acc_commands BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_audit_update BEFORE UPDATE ON acc_audit BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_audit_delete BEFORE DELETE ON acc_audit BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_bank_accounts_update BEFORE UPDATE ON acc_bank_accounts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;

--> statement-breakpoint
CREATE TRIGGER acc_bank_accounts_delete BEFORE DELETE ON acc_bank_accounts BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
