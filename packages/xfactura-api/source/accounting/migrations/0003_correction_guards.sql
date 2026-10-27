-- Drizzle custom migration: append-only correction links and exact approved postings.
-- Table definitions remain generated from schema.ts in 0002_purchase_corrections.sql.
CREATE TRIGGER acc_guard_correction_journal BEFORE INSERT ON acc_journals
WHEN NEW.kind='correction' BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_proposals p
    JOIN acc_approvals a ON a.company_id=p.company_id AND a.proposal_id=p.id
    JOIN acc_journals target ON target.company_id=p.company_id AND target.id=json_extract(p.body,'$.journalId')
    JOIN acc_proposals purchase ON purchase.company_id=p.company_id AND purchase.id=json_extract(p.body,'$.purchaseProposalId')
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id AND p.kind='correction'
      AND a.id=NEW.approval_id AND a.version=p.version AND a.hash=p.hash
      AND purchase.kind='purchase' AND json_extract(p.body,'$.method')='inverse_entry'
      AND json_extract(p.body,'$.date')=NEW.date AND NEW.date>=target.date
      AND json_extract(p.body,'$.evidenceId')=NEW.evidence_id
      AND ((target.kind='purchase' AND target.source_id=purchase.id
        AND json_extract(p.body,'$.previousAmount')=json_extract(purchase.body,'$.amount'))
        OR (target.kind='correction' AND EXISTS (
          SELECT 1 FROM acc_correction_outcomes previous
          JOIN acc_proposals prior ON prior.company_id=previous.company_id AND prior.id=previous.proposal_id
          WHERE previous.company_id=p.company_id AND previous.journal_id=target.id
            AND previous.status='posted' AND previous.purchase_proposal_id=purchase.id
            AND json_extract(prior.body,'$.amount')=json_extract(p.body,'$.previousAmount')
        )))
  ) THEN RAISE(ABORT,'invalid_correction_approval_or_basis') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM acc_correction_outcomes o JOIN acc_proposals p ON p.company_id=o.company_id
    WHERE p.company_id=NEW.company_id AND p.id=NEW.source_id
      AND (o.proposal_id=p.id OR (o.target_journal_id=json_extract(p.body,'$.journalId') AND o.status='posted'))
  ) THEN RAISE(ABORT,'resolved_correction') END;
  SELECT CASE WHEN NEW.lines_json<>(
    WITH amounts AS (
      SELECT CAST(CAST(replace(json_extract(body,'$.previousAmount'),'.','') AS INTEGER) AS TEXT) AS old_amount,
             CAST(CAST(replace(json_extract(body,'$.amount'),'.','') AS INTEGER) AS TEXT) AS new_amount
      FROM acc_proposals WHERE company_id=NEW.company_id AND id=NEW.source_id
    )
    SELECT CASE
      WHEN new_amount='0' THEN json_array(
        json_object('account','628','debitBani','0','creditBani',old_amount),
        json_object('account','401','debitBani',old_amount,'creditBani','0'))
      WHEN old_amount='0' THEN json_array(
        json_object('account','628','debitBani',new_amount,'creditBani','0'),
        json_object('account','401','debitBani','0','creditBani',new_amount))
      ELSE json_array(
        json_object('account','628','debitBani','0','creditBani',old_amount),
        json_object('account','401','debitBani',old_amount,'creditBani','0'),
        json_object('account','628','debitBani',new_amount,'creditBani','0'),
        json_object('account','401','debitBani','0','creditBani',new_amount))
      END FROM amounts
  ) THEN RAISE(ABORT,'correction_lines_differ_from_approval') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_guard_correction_outcome BEFORE INSERT ON acc_correction_outcomes BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM acc_proposals p WHERE p.company_id=NEW.company_id AND p.id=NEW.proposal_id
      AND p.kind='correction' AND json_extract(p.body,'$.journalId')=NEW.target_journal_id
      AND json_extract(p.body,'$.purchaseProposalId')=NEW.purchase_proposal_id
      AND (NEW.status='withdrawn' OR EXISTS (
        SELECT 1 FROM acc_journals j WHERE j.company_id=NEW.company_id AND j.id=NEW.journal_id
          AND j.kind='correction' AND j.source_id=NEW.proposal_id
      ))
  ) THEN RAISE(ABORT,'invalid_correction_link') END;
END;
--> statement-breakpoint
CREATE TRIGGER acc_correction_outcome_update BEFORE UPDATE ON acc_correction_outcomes
BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_correction_outcome_delete BEFORE DELETE ON acc_correction_outcomes
BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
--> statement-breakpoint
CREATE TRIGGER acc_resolved_correction_update BEFORE UPDATE ON acc_proposals
WHEN EXISTS (SELECT 1 FROM acc_correction_outcomes WHERE company_id=OLD.company_id AND proposal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'resolved_correction'); END;
--> statement-breakpoint
CREATE TRIGGER acc_withdrawn_correction_approval BEFORE INSERT ON acc_approvals
WHEN EXISTS (SELECT 1 FROM acc_correction_outcomes WHERE company_id=NEW.company_id AND proposal_id=NEW.proposal_id AND status='withdrawn')
BEGIN SELECT RAISE(ABORT,'withdrawn_correction'); END;
