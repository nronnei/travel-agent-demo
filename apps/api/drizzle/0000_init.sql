CREATE SCHEMA "intake";
--> statement-breakpoint
CREATE TABLE "intake"."conversations" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"thread_id" text NOT NULL,
	"parlant_session_id" text,
	"identity" jsonb NOT NULL,
	"trip" jsonb,
	"draft" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE INDEX "conversations_last_seen_at_idx" ON "intake"."conversations" USING btree ("last_seen_at");