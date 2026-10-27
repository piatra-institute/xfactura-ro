-- Generated as a Drizzle custom migration: workflow invariants are not table DDL.
CREATE TRIGGER acc_action_review_insert BEFORE INSERT ON acc_action_reviews
WHEN NEW.operation NOT IN ('bank.match','periods.close')
  OR NOT json_valid(NEW.input) OR NOT json_valid(NEW.effect)
  OR json_extract(NEW.effect, '$.kind') IS NOT NEW.operation
  OR length(NEW.hash) != 64 OR NEW.hash GLOB '*[^a-f0-9]*'
  OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
  OR NEW.result IS NOT NULL OR NEW.executed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'invalid initial action review'); END;
--> statement-breakpoint
CREATE TRIGGER acc_action_review_update BEFORE UPDATE ON acc_action_reviews
WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
  OR NEW.operation IS NOT OLD.operation OR NEW.input IS NOT OLD.input
  OR NEW.effect IS NOT OLD.effect OR NEW.hash IS NOT OLD.hash
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR OLD.executed_at IS NOT NULL
  OR (OLD.approved_at IS NOT NULL AND (NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at))
  OR (NEW.approved_by IS NULL) != (NEW.approved_at IS NULL)
  OR (NEW.result IS NULL) != (NEW.executed_at IS NULL)
  OR (NEW.executed_at IS NOT NULL AND NEW.approved_at IS NULL)
  OR (NEW.result IS NOT NULL AND NOT json_valid(NEW.result))
BEGIN SELECT RAISE(ABORT, 'protected action review'); END;
--> statement-breakpoint
CREATE TRIGGER acc_action_review_delete BEFORE DELETE ON acc_action_reviews
BEGIN SELECT RAISE(ABORT, 'action reviews are retained'); END;
--> statement-breakpoint
CREATE TRIGGER acc_agent_grant_update BEFORE UPDATE ON acc_agent_grants
WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.scopes IS NOT OLD.scopes
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at > OLD.expires_at
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'agent authority cannot be expanded or revived'); END;
--> statement-breakpoint
CREATE TRIGGER acc_agent_grant_delete BEFORE DELETE ON acc_agent_grants
BEGIN SELECT RAISE(ABORT, 'agent grants are retained'); END;
