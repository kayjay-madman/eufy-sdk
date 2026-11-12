import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * `MqttCommandRouter.dispatchCommand` on the `ff09-actuate` intent — no live broker: `ensureSecurityMqttFor`
 * is stubbed, device resolution comes from the injected `listDevices`, and the "MQTT connection" is a
 * bare EventEmitter standing in for `SecureMqtt` (subscribe/publish/disconnect are no-ops; `message`
 * events are emitted manually to simulate a device `/res` reply). Fake timers drive the ack-wait
 * deterministically instead of a real multi-second sleep. `commandAck` is asserted via the injected
 * `onCommandAck` callback (the facade re-emits it as the `commandAck` event).
 */
function makeRouter() {
  const dev = { sn: "T85D0K0000000000", category: "eufy_security", model: "T85D0" } as unknown as EufyDevice;
  const acks: any[] = [];
  const router = new MqttCommandRouter({
    mega: {} as any,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: (info) => acks.push(info),
    onError: () => {},
  });

  const fakeMqtt = new EventEmitter() as EventEmitter & {
    id: string;
    subscribeDevice: (d: EufyDevice) => Promise<void>;
    publish: (topic: string, body: string, opts?: unknown) => Promise<void>;
    disconnect: () => Promise<void>;
  };
  fakeMqtt.id = "client-1";
  fakeMqtt.subscribeDevice = vi.fn().mockResolvedValue(undefined);
  fakeMqtt.publish = vi.fn().mockResolvedValue(undefined);
  fakeMqtt.disconnect = vi.fn().mockResolvedValue(undefined);

  vi.spyOn(router as any, "ensureSecurityMqttFor").mockResolvedValue({ mqtt: fakeMqtt, instanceIp: "198.51.100.7" });

  const cmd = {
    kind: "ff09-actuate" as const,
    engage: true,
    adminUserId: "0000000000000000000000000000000000000000",
    username: "someone+tag",
    shortUserId: "0003",
    deviceSn: "T85D0K0000000000",
  };
  return { router, fakeMqtt, cmd, acks };
}

describe("MqttCommandRouter.claimsDevice", () => {
  it("claims a eufy-cloud device with no p2p_did endpoint (MQTT-only lock/garage), declines a P2P one", () => {
    expect(MqttCommandRouter.claimsDevice({ api: "mega", p2pDid: "" } as EufyDevice)).toBe(true);
    expect(MqttCommandRouter.claimsDevice({ api: "mega" } as EufyDevice)).toBe(true);
    expect(MqttCommandRouter.claimsDevice({ api: "mega", p2pDid: "DID-XYZ" } as EufyDevice)).toBe(false);
  });

  it("does NOT claim a device on another cloud — a printer isn't swept onto the eufy MQTT plane", () => {
    // api "ankermake" (a printer): no P2P endpoint, but not this stack's plane → neither router claims it.
    expect(MqttCommandRouter.claimsDevice({ api: "ankermake", p2pDid: "" } as EufyDevice)).toBe(false);
  });
});

describe("MqttCommandRouter.dispatchCommand (ff09-actuate)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("subscribes BEFORE publishing (no race between listener attach and an instant reply)", async () => {
    const { router, fakeMqtt, cmd } = makeRouter();
    const order: string[] = [];
    (fakeMqtt.subscribeDevice as any).mockImplementation(async () => order.push("subscribe"));
    (fakeMqtt.publish as any).mockImplementation(async () => order.push("publish"));

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(order).toEqual(["subscribe", "publish"]);
  });

  it("resolves as soon as the /res message arrives, without waiting the full timeout", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0); // let subscribe+publish microtasks settle
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/res" });
    await p;

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: true, instanceIp: "198.51.100.7" }]);
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });

  it("resolves (does not throw) on timeout with no reply, reporting acked:false", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeUndefined(); // fire-and-forget: no ack is not an error

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false, instanceIp: "198.51.100.7" }]);
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });

  it("ignores a message on an unrelated topic (not a /res suffix)", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0);
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/req" }); // not /res
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false, instanceIp: "198.51.100.7" }]);
  });

  it("always disconnects, even when the publish throws", async () => {
    const { router, fakeMqtt, cmd } = makeRouter();
    (fakeMqtt.publish as any).mockRejectedValue(new Error("broker down"));

    await expect(router.dispatchCommand("T85D0K0000000000", cmd)).rejects.toThrow("broker down");
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });
});

describe("MqttCommandRouter ff09 topics — addressed by the record's product number", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A C30's record: model `T85D0C`, product number `T85D0` — it answers only on the product number's topics. */
  it("probes, subscribes and publishes under device_new_pn where the record carries one", async () => {
    const c30 = {
      sn: "T85D0K0000000000",
      category: "eufy_security",
      model: "T85D0C",
      raw: { device_new_pn: "T85D0" },
    } as unknown as EufyDevice;
    const router = new MqttCommandRouter({
      mega: {} as any,
      listDevices: () => [c30],
      ensureDevices: async () => {},
      onCommandAck: () => {},
      onError: () => {},
    });
    const fakeMqtt = Object.assign(new EventEmitter(), {
      id: "client-1",
      subscribeDevice: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    });
    const ensure = vi
      .spyOn(router as any, "ensureSecurityMqttFor")
      .mockResolvedValue({ mqtt: fakeMqtt, instanceIp: "198.51.100.7" });

    const p = router.dispatchCommand(c30.sn, { ...makeRouter().cmd, deviceSn: c30.sn });
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect((ensure.mock.calls[0]![0] as EufyDevice).model).toBe("T85D0");
    expect(fakeMqtt.subscribeDevice.mock.calls[0]![0].model).toBe("T85D0");
    expect(fakeMqtt.publish.mock.calls[0]![0]).toBe(`cmd/eufy_security/T85D0/${c30.sn}/req`);
  });
});
