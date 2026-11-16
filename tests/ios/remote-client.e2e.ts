import { test as mobileTest } from "@e2e-dev/mobile";
import { expect, type Screen } from "e2e";

import { RemoteFixture, transcript } from "./remote-fixture.js";

const test = mobileTest.extend<{ remote: RemoteFixture }>({
  remote: async ({ device, app }, use) => {
    const remote = await RemoteFixture.start();
    try {
      await device.installApp(undefined, { reinstall: true });
      await app.open();
      await use(remote);
    } finally {
      await remote.close();
    }
  },
});

async function pair(
  screen: Screen,
  remote: RemoteFixture,
  device: { setClipboard(text: string): Promise<void> },
) {
  await expect(
    screen.getByText("Watch and steer the Pi sessions running on your laptop."),
  ).toBeVisible();
  await device.setClipboard(remote.daemon.ticket);
  await screen.getByRole("button", "Paste").tap();
  await expect(screen.getByText("Enter Pairing Code")).toBeVisible();
  await screen.getByRole("textbox", "Pairing code").fill("123456");
  await screen.getByRole("button", "Pair", { exact: true }).tap();
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
}

test("pairs, lists a session, and renders its backfill", async ({ remote, device, screen }) => {
  await remote.addSession();
  await pair(screen, remote, device);
  await screen.getByText("E2E Session", { exact: false }).tap();
  await expect(screen.getByText("Ready to help.")).toBeVisible();
  await expect(screen.getByRole("button", "Send")).toBeDisabled();
});

test("rejects an invalid ticket, goes back, and retries a wrong pairing code", async ({
  remote,
  device,
  screen,
}) => {
  await device.setClipboard("not a ticket");
  await screen.getByRole("button", "Paste").tap();
  await expect(
    screen.getByText("Copy the Ticket line printed by /remote pair, then try again."),
  ).toBeVisible();
  await device.setClipboard(remote.daemon.ticket);
  await screen.getByRole("button", "Paste").tap();
  await screen.getByRole("button", "Back").tap();
  await expect(screen.getByText("Pi Remote")).toBeVisible();
  await screen.getByRole("button", "Paste").tap();
  await expect(screen.getByRole("button", "Pair", { exact: true })).toBeDisabled();
  await screen.getByRole("textbox", "Pairing code").fill("12");
  await expect(screen.getByRole("button", "Pair", { exact: true })).toBeDisabled();
  await screen.getByRole("textbox").fill("000000");
  await screen.getByRole("button", "Pair", { exact: true }).tap();
  await expect(screen.getByText("That code didn't match.", { exact: false })).toBeVisible();
  await screen.getByRole("textbox").fill("123456");
  await screen.getByRole("button", "Pair", { exact: true }).tap();
  await expect(screen.getByText("No Sessions")).toBeVisible();
});

test("refreshes an empty registry and removes ended sessions", async ({
  remote,
  device,
  screen,
}) => {
  await pair(screen, remote, device);
  await expect(screen.getByText("No Sessions")).toBeVisible();
  await screen.getByRole("button", "Refresh").tap();
  await remote.addSession();
  await expect(screen.getByText("E2E Session", { exact: false })).toBeVisible();
  await remote.endSession();
  await expect(screen.getByText("No Sessions")).toBeVisible();
});

test("sends a prompt, steers while working, and stops the agent", async ({
  remote,
  device,
  screen,
}) => {
  await remote.addSession();
  await pair(screen, remote, device);
  await screen.getByText("E2E Session", { exact: false }).tap();
  await screen.getByRole("textbox").fill("   ");
  await expect(screen.getByRole("button", "Send")).toBeDisabled();
  await screen.getByRole("textbox").fill("  Inspect the code  ");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText("Working on your request")).toBeVisible();
  await screen.getByRole("textbox").fill("Focus on tests");
  await screen.getByRole("button", "Send").tap();
  await screen.getByRole("button", "Stop", { exact: true }).tap();
  await expect(screen.getByText("Stopped on request.")).toBeVisible();
  await expect(screen.getByRole("button", "Stop", { exact: true })).toHaveCount(0);
  expect(remote.prompts).toEqual(["Inspect the code", "Focus on tests"]);
  expect(remote.aborts).toBe(1);
});

test("expands tool output, displays truncation and failure, and copies output", async ({
  remote,
  device,
  screen,
}) => {
  await remote.addSession("session-1", "E2E Session", false);
  await pair(screen, remote, device);
  await screen.getByText("E2E Session", { exact: false }).tap();
  await expect(screen.getByText("No Messages Yet")).toBeVisible();
  await remote.emit({
    ...transcript("toolResult", "", "running"),
    toolName: "bash",
    toolCallId: "tool-1",
  });
  await expect(screen.getByRole("status", "bash, running")).toBeVisible();
  await expect(screen.getByRole("status", "bash, running")).toBeDisabled();
  await remote.emit({
    ...transcript("toolResult", "First line\nDetailed failure output", "error"),
    toolName: "bash",
    toolCallId: "tool-1",
    truncatedOutput: true,
  });
  await expect(screen.getByRole("button", "bash, failed")).toBeVisible();
  await screen.getByRole("button", "bash, failed").tap();
  await expect(screen.getByText("First line\nDetailed failure output")).toBeVisible();
  await expect(screen.getByText("Output truncated by the laptop")).toBeVisible();
  await screen.getByText("First line\nDetailed failure output").longPress();
  await screen.getByRole("button", "Copy").tap();
  expect(await device.clipboard()).toBe("First line\nDetailed failure output");
});

test("changes model and thinking level using host state", async ({ remote, device, screen }) => {
  await remote.addSession();
  await pair(screen, remote, device);
  await screen.getByText("E2E Session", { exact: false }).tap();
  await expect(screen.getByText("alpha · medium")).toBeVisible();
  await screen.getByRole("navigation").getByText("E2E Session").tap();
  await screen.getByRole("button", /^Model/).tap();
  await screen.getByRole("button", "Beta").tap();
  await expect(screen.getByText("beta · medium", { exact: false })).toBeVisible();
  await screen.getByRole("navigation").getByText("E2E Session").tap();
  await screen.getByRole("button", /^Thinking/).tap();
  await screen.getByRole("button", "high").tap();
  await expect(screen.getByText("beta · high", { exact: false })).toBeVisible();
  expect(remote.prompts).toEqual(["/model test/beta", "/thinking high"]);
});

test("opens a context capsule and reports capsule failures", async ({ remote, device, screen }) => {
  await remote.addSession();
  await pair(screen, remote, device);
  await screen.getByText("E2E Session", { exact: false }).tap();
  await screen.getByRole("button", "Actions").tap();
  await screen.getByRole("button", "Context Capsule").tap();
  await expect(screen.getByText("Verify remote control")).toBeVisible();
  await screen.getByRole("button", "Done").tap();
  remote.capsuleFails = true;
  await screen.getByRole("button", "Actions").tap();
  await screen.getByRole("button", "Context Capsule").tap();
  await screen.getByRole("button", "Actions").tap();
  await expect(
    screen.getByRole("button", "Context Capsule unavailable: Capsule is unavailable."),
  ).toBeVisible();
});

test("reconnects without duplicated backfill and switches sessions", async ({
  remote,
  device,
  screen,
}) => {
  await remote.addSession();
  await remote.addSession("session-2", "Second Session", false);
  await pair(screen, remote, device);
  await screen.getByText("E2E Session", { exact: false }).tap();
  await expect(screen.getByText("Ready to help.")).toBeVisible();
  remote.historyText = "History after reconnect.";
  await screen.getByRole("button", "Actions").tap();
  await screen.getByRole("button", "Reconnect").tap();
  await expect(screen.getByText("History after reconnect.")).toHaveCount(1);
  await expect(screen.getByText("Ready to help.")).toHaveCount(0);
  await screen.getByRole("button", "Sessions").tap();
  await screen.getByText("Second Session", { exact: false }).tap();
  await expect(screen.getByText("No Messages Yet")).toBeVisible();
  await remote.endSession("session-2");
  await expect(screen.getByRole("button", "Reconnect")).toBeVisible();
  await expect(screen.getByRole("button", "Send")).toBeDisabled();
});

test("persists pairing and device identity, cancels re-pair, then pairs again", async ({
  remote,
  device,
  app,
  screen,
}) => {
  await pair(screen, remote, device);
  await screen.getByRole("button", "Settings").tap();
  await screen.getByRole("button", "Copy Device ID").tap();
  const nodeID = await device.clipboard();
  expect(nodeID).toMatch(/^[a-f0-9]{64}$/);
  await screen.getByRole("button", "Pair Again").tap();
  await screen.getByTestId("PopoverDismissRegion").tap();
  await screen.getByRole("button", "Done").tap();
  await app.open();
  await expect(screen.getByText("No Sessions")).toBeVisible();
  await screen.getByRole("button", "Settings").tap();
  await screen.getByRole("button", "Copy Device ID").tap();
  expect(await device.clipboard()).toBe(nodeID);
  await screen.getByRole("button", "Pair Again").tap();
  await screen.getByRole("button", "Forget Laptop and Pair Again").tap();
  await remote.armPairing();
  await pair(screen, remote, device);
});

test("reports an unusable saved ticket and recovers through re-pairing", async ({
  remote,
  device,
  app,
  screen,
}) => {
  await device.openApp("works.earendil.pi-remote-client", {
    relaunch: true,
    launchArguments: ["-remote.ticket", "invalid-ticket"],
  });
  await expect(screen.getByText("Can't Reach Your Laptop")).toBeVisible();
  await screen.getByRole("button", "Try Again").tap();
  await expect(screen.getByText("Can't Reach Your Laptop")).toBeVisible();
  await screen.getByRole("button", "Settings").tap();
  await screen.getByRole("button", "Pair Again").tap();
  await screen.getByRole("button", "Forget Laptop and Pair Again").tap();
  await pair(screen, remote, device);
  await app.open();
  await expect(screen.getByText("No Sessions")).toBeVisible();
});
