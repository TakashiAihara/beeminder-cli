#!/usr/bin/env bun
import { Command } from "commander";

const notImplemented = (): never => {
  process.stderr.write("not implemented\n");
  process.exit(1);
};

const program = new Command();

program.name("beeminder").description("CLI for the Beeminder API");

const withUser = (cmd: Command): Command =>
  cmd.option("--user <username>", "Beeminder username", "me");

withUser(program.command("user").description("Show the user")).action(notImplemented);

withUser(program.command("goals").description("List goals")).action(notImplemented);

withUser(program.command("goal").description("Show one goal").argument("<slug>")).action(
  notImplemented,
);

withUser(
  program.command("datapoints").description("List datapoints of a goal").argument("<slug>"),
).action(notImplemented);

withUser(
  program
    .command("add")
    .description("Add a datapoint")
    .argument("<slug>")
    .argument("<value>")
    .option("--comment <text>", "datapoint comment")
    .option("--requestid <id>", "idempotency key")
    .option("--daystamp <YYYYMMDD>", "date of the datapoint"),
).action(notImplemented);

withUser(
  program.command("delete").description("Delete a datapoint").argument("<slug>").argument("<id>"),
).action(notImplemented);

await program.parseAsync();
