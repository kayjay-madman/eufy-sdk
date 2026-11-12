import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";
import { CMD_TRANSFER_PAYLOAD, decryptFf09Frame, walkFf09Tlv } from "../../ff09.js";
import { buildFf09ResponseFrame } from "../../__tests__/ff09-test-fixtures.js";

/**
 * `MqttCommandRouter.exchangeFf09` — one `ff09` command and its decrypted reply, on the fake-wire harness
 * the settings specs use. The reply shapes are the Smart Lock C33's: an add-passcode answer (`0x4824`,
 * status then the password id in `a1`), and the unencrypted state report it pushes under the request's
 * own `time` after an actuation.
 */
const ADMIN = "0".repeat(40);
const SN = "T85L0K0000000000";

function emitRes(mqtt: EventEmitter, lockPayload: string, time: number): void {
  const trans = {
    cmd: CMD_TRANSFER_PAYLOAD,
    payload: { dev_sn: SN, lock_payload: lockPayload, time: time.toString(16) },
  };
  mqtt.emit("message", {
    topic: `cmd/eufy_security/T85L0/${SN}/res`,
    raw: {
      head: { cmd: 8 },
      payload: JSON.stringify({ trans: Buffer.from(JSON.stringify(trans)).toString("base64") }),
    },
  });
}

/** The C33's unencrypted state report: `cmdEnc` 0x004a, battery 100 and state 3 (unlocked). */
const STATE_REPORT = (() => {
  const pre = Buffer.from("ff091400030102004a00a10164a20103a30100", "hex");
  let xor = 0;
  for (const b of pre) xor ^= b;
  return Buffer.concat([pre, Buffer.from([xor])]).toString("hex");
})();

function makeRouter(answer: (time: number, mqtt: EventEmitter) => void, raw?: Record<string, unknown>) {
  const dev = { sn: SN, category: "eufy_security", model: raw ? "T85L0C" : "T85L0", raw } as unknown as EufyDevice;
  const router = new MqttCommandRouter({
    mega: {} as any,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: () => {},
    onError: () => {},
  });
  const published: string[] = [];
  const fakeMqtt = Object.assign(new EventEmitter(), {
    id: "client-1",
    subscribeDevice: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(async (_topic: string, body: string) => {
      published.push(body);
      answer(transOf(body).payload.time, fakeMqtt);
    }),
  });
  vi.spyOn(router as any, "ensureSecurityMqttFor").mockResolvedValue({ mqtt: fakeMqtt, instanceIp: "198.51.100.7" });
  return { router, fakeMqtt, published };
}

function transOf(body: string): { payload: { apiCommand: number; lock_payload: string; time: number } } {
  return JSON.parse(Buffer.from(JSON.parse(JSON.parse(body).payload).trans, "base64").toString("utf8"));
}

const REQUEST = {
  adminUserId: ADMIN,
  deviceSn: SN,
  commandCode: 0x24,
  apiCommand: 6012,
  fields: [Buffer.from("13572468", "ascii"), Buffer.from([4])],
};

describe("MqttCommandRouter.exchangeFf09", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes the opcode and fields after time and account id, and answers the decrypted reply", async () => {
    const { router, fakeMqtt, published } = makeRouter((time, mqtt) =>
      emitRes(mqtt, buildFf09ResponseFrame(Buffer.from("00a1020007", "hex"), time, ADMIN, SN, 0x4824), time),
    );

    const reply = await router.exchangeFf09(SN, REQUEST);

    expect(reply.status).toBe(0);
    expect(reply.fields.get(0xa1)?.toString("hex")).toBe("0007");
    const { payload } = transOf(published[0]!);
    expect(payload.apiCommand).toBe(6012);
    expect(payload.lock_payload.slice(14, 18)).toBe("4024");
    const plain = decryptFf09Frame({
      lockPayload: payload.lock_payload,
      keyTime: payload.time,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    const tlv = walkFf09Tlv(plain, 0, plain.length);
    expect(tlv.get(0xa2)?.toString("ascii")).toBe(ADMIN);
    expect(tlv.get(0xa3)?.toString("ascii")).toBe("13572468");
    expect(tlv.get(0xa4)?.toString("hex")).toBe("04");
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });

  it("passes over a state report carrying the request's time, and resolves on the reply to its opcode", async () => {
    const { router } = makeRouter((time, mqtt) => {
      emitRes(mqtt, STATE_REPORT, time);
      emitRes(mqtt, buildFf09ResponseFrame(Buffer.from("00a1020001", "hex"), time, ADMIN, SN, 0x4824), time);
    });

    await expect(router.exchangeFf09(SN, REQUEST)).resolves.toMatchObject({ status: 0 });
  });

  it("resolves a refusal with its status rather than rejecting", async () => {
    const { router } = makeRouter((time, mqtt) =>
      emitRes(mqtt, buildFf09ResponseFrame(Buffer.from([4]), time, ADMIN, SN, 0x4824), time),
    );

    await expect(router.exchangeFf09(SN, REQUEST)).resolves.toMatchObject({ status: 4 });
  });

  it("publishes under the record's product number where it differs from the model", async () => {
    const { router, fakeMqtt } = makeRouter(
      (time, mqtt) => emitRes(mqtt, buildFf09ResponseFrame(Buffer.from([0]), time, ADMIN, SN, 0x4824), time),
      { device_new_pn: "T85L0" },
    );

    await router.exchangeFf09(SN, REQUEST);
    expect(fakeMqtt.publish.mock.calls[0]![0]).toBe(`cmd/eufy_security/T85L0/${SN}/req`);
  });

  it("rejects when no reply arrives, still disconnecting", async () => {
    const { router, fakeMqtt } = makeRouter(() => {});

    const p = router.exchangeFf09(SN, REQUEST);
    const assertion = expect(p).rejects.toThrow(/no ff09 0x24 reply/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });
});
