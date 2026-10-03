CREATE TABLE `issue_222_roundtrips` (
	`trial_key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`command_json` text NOT NULL,
	`command_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`acked_at` text,
	`response_json` text,
	`response_sha256` text
);
