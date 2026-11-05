-- Agents never approve, decide or grant a policy: each records the acting agent, which the
-- database refuses (inv:approval_person, inv:decision_person, inv:policy_person). The data step
-- of this migration (db/identity.ts, rekeyIndividuals) then replaces every individual's unkeyed
-- party identifier (cnp:<sha256>) with its keyed form, under the installation's secret.
ALTER TABLE `acc_action_decisions` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `acc_approvals` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `acc_posting_policies` ADD `agent_id` text;