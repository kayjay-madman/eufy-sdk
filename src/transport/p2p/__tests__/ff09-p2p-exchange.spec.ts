import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StationKeyUnavailableError } from "../../../core/contracts.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { CMD_TRANSFER_PAYLOAD, decryptFf09Frame, walkFf09Tlv } from "../../ff09.js";
import { buildFf09ResponseFrame } from "../../__tests__/ff09-test-fixtures.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * `P2PCommandRouter.exchangeFf09` — one `ff09` command and its decrypted reply over the device's P2P
 * session, on the fake-session harness the settings specs use. The reply is an add-passcode answer
 * (`0x4824`, status then the password id in `a1`); a state report echoes the request's `time` under
 * another opcode.
 */
const ADMIN = "0".repeat(40);
const LOCK_SN = "T8506K0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADD = { commandCode: 0x24, apiCommand: 6012, fields: [Buffer.from("1234", "ascii"), Buffer.from([4])] };

interface Session extends FakeP2PSession {
  refusedLevel2: boolean;
  sendControlLevel2: ReturnType<typeof vi.fn>;
}

type Answer = (time: number, session: Session) => void;

function emitReply(session: Session, lockPayload: string, time: number): void {
  session.emit("data", {
    json: {
      cmd: CMD_TRANSFER_PAYLOAD,
      payload: { dev_sn: LOCK_SN, lock_payload: lockPayload, time: time.toString(16) },
    },
  });
}

const reply = (plainHex: string, time: number, cmdEnc = 0x4824) =>
  buildFf09ResponseFrame(Buffer.from(plainHex, "hex"), time, ADMIN, LOCK_SN, cmdEnc);

function makeRouter(answer: Answer | undefined, { refused = false, model = "T8506" } = {}) {
  const session = connectedSession(!refused) as Session;
  session.refusedLevel2 = refused;
  let answered = false;
  session.sendControlLevel2 = vi.fn((_cmd, _channel, _accountId, payload) => {
    if (answer && !answered) {
      answered = true;
      queueMicrotask(() => answer((payload as { time: number }).time, session));
    }
    return true;
  });
  const lock = {
    sn: LOCK_SN,
    model,
    stationSn: LOCK_SN,
    channel: 0,
    p2pDid: P2P_DID,
    raw: { device_channel: 0, member: { admin_user_id: ADMIN } },
  };
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [lock] as never,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(LOCK_SN, session);
  return { router, session };
}

const exchange = (router: P2PCommandRouter) =>
  router.exchangeFf09(LOCK_SN, { adminUserId: ADMIN, deviceSn: LOCK_SN, ...ADD });

describe("P2PCommandRouter.exchangeFf09", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the opcode and fields after time and account id on the lock's channel, and answers the decrypted reply", async () => {
    const { router, session } = makeRouter((time, s) => emitReply(s, reply("00a1020007", time), time));

    const p = exchange(router);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(p).resolves.toEqual({ status: 0, fields: new Map([[0xa1, Buffer.from("0007", "hex")]]) });
    const [cmd, channel, , payload] = session.sendControlLevel2.mock.calls[0]!;
    expect([cmd, channel, payload.apiCommand]).toEqual([CMD_TRANSFER_PAYLOAD, 0, 6012]);
    expect(Buffer.from(payload.lock_payload, "hex").readUInt16BE(7)).toBe(0x4024);
    const plain = decryptFf09Frame({
      lockPayload: payload.lock_payload,
      keyTime: payload.time,
      adminUserId: ADMIN,
      deviceSn: LOCK_SN,
    });
    const tlv = walkFf09Tlv(plain, 0, plain.length);
    expect(tlv.get(0xa2)?.toString("ascii")).toBe(ADMIN);
    expect(tlv.get(0xa3)?.toString("ascii")).toBe("1234");
    expect(tlv.get(0xa4)?.toString("hex")).toBe("04");
  });

  it("passes over a frame under the request's time with another opcode, and resolves on the reply to its own", async () => {
    const { router } = makeRouter((time, s) => {
      emitReply(s, reply("00a10164", time, 0x4822), time);
      emitReply(s, reply("00a1020007", time), time);
    });

    const p = exchange(router);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(p).resolves.toMatchObject({ status: 0, fields: new Map([[0xa1, Buffer.from("0007", "hex")]]) });
  });

  it("resolves a refusal with its status rather than rejecting", async () => {
    const { router } = makeRouter((time, s) => emitReply(s, reply("04", time), time));

    const p = exchange(router);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(p).resolves.toMatchObject({ status: 4 });
  });

  it("rejects when no reply arrives", async () => {
    const { router } = makeRouter(undefined);

    const assertion = expect(exchange(router)).rejects.toThrow(/no ff09 0x24 reply/);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });

  it("sends in the clear on a standalone C220 whose station refused level-2", async () => {
    const { router, session } = makeRouter((time, s) => emitReply(s, reply("00a1020007", time), time), {
      refused: true,
    });

    const p = exchange(router);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(p).resolves.toMatchObject({ status: 0 });
    expect(session.sendControlLevel2.mock.calls[0]![5]).toBe(true);
  });

  it("still refuses on another model whose station refused level-2", async () => {
    const { router, session } = makeRouter(undefined, { refused: true, model: "T8531" });

    await expect(exchange(router)).rejects.toBeInstanceOf(StationKeyUnavailableError);
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });
});
