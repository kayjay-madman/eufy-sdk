import { describe, expect, it, vi } from "vitest";

import { MegaHttpClient } from "../mega-client.js";

/** The cloud's local-user records: the request bodies the vendor app sends, and the short id they answer. */
function client(answer: unknown) {
  const mega = new MegaHttpClient({
    email: "synthetic@example.invalid",
    password: "synthetic",
    countryCode: "US",
    region: "us-pr",
  });
  const securityAppPost = vi.fn(async () => answer);
  (mega as unknown as { securityAppPost: typeof securityAppPost }).securityAppPost = securityAppPost;
  return { mega, securityAppPost };
}

const LOCK = "T85L0K0000000000";

describe("MegaHttpClient device local users", () => {
  it("creates a user with an empty station for a device that is its own station, answering its short id", async () => {
    const { mega, securityAppPost } = client({ short_user_id: "0002", user_id: "synthetic" });

    await expect(mega.addDeviceLocalUser(LOCK, "", "Guest")).resolves.toEqual({ shortUserId: "0002" });
    expect(securityAppPost).toHaveBeenCalledWith("/v3/app/device/local_user/add", {
      device_sn: LOCK,
      nick_name: "Guest",
      station_sn: "",
    });
  });

  it("names the parent station for a device that has one", async () => {
    const { mega, securityAppPost } = client({ short_user_id: "0002" });

    await mega.addDeviceLocalUser(LOCK, "T8030K0000000000", "Guest");
    expect(securityAppPost).toHaveBeenCalledWith(
      "/v3/app/device/local_user/add",
      expect.objectContaining({ station_sn: "T8030K0000000000" }),
    );
  });

  it("rejects an answer without a 4-hex-digit short id", async () => {
    await expect(client({}).mega.addDeviceLocalUser(LOCK, "", "Guest")).rejects.toThrow(/no short_user_id/);
    await expect(client({ short_user_id: 2 }).mega.addDeviceLocalUser(LOCK, "", "Guest")).rejects.toThrow(
      /no short_user_id/,
    );
  });

  it("records a password under its user as a one-entry password list", async () => {
    const { mega, securityAppPost } = client(null);

    await mega.saveDevicePassword(LOCK, "", "0002", { passwordId: "0002", passwordType: 1, schedule: "{}" });
    expect(securityAppPost).toHaveBeenCalledWith("/v3/app/device/password/save_or_update", {
      device_sn: LOCK,
      short_user_id: "0002",
      station_sn: "",
      password_list: [{ password_id: "0002", password_type: 1, schedule: "{}" }],
    });
  });
});
