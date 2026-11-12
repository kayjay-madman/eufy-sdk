import {
  buildFf09CommandFrame,
  buildFf09Frame,
  decryptFf09Frame,
  ff09FrameCode,
  LOCK_API_COMMAND,
  walkFf09Tlv,
} from "../ff09.js";

/**
 * Byte-exact reproduction of a captured T8531 video-lock command.
 *
 * Originally a real ON_OFF_LOCK **unlock** frame decrypted from a live P2P capture (the `lock_payload`
 * + its cleartext `time`/`seq_num` from the 1940 envelope) — the real admin_user_id/serial were
 * re-derived to synthetic placeholders (docs/REDACTION.md) and this vector regenerated from the
 * (unchanged) encoder against the synthetic identity. Reproducing it byte-for-byte from the decoded
 * identity fields still proves the encoder's frame layout, TLV, zero-pad-to-16, AES-128-CBC key
 * (`admin_user_id[-12:] ‖ uint32_BE(time)`) + IV (`deviceSn`), and the XOR checksum are all correct.
 */
describe("ff09 frame encoder", () => {
  // Synthetic identity (see docs/REDACTION.md) — originally decoded from the captured frame.
  const adminUserId = "0000000000000000000000000000000000000000";
  const username = "someone+tag";
  const shortUserId = "0003";
  const deviceSn = "T8531K0000000000";
  // Captured envelope: time (key nonce) = unixTime | 1; seq_num is the monotonic counter.
  const unixTime = 1783612332;
  const nonce = 1; // keyTime = 1783612332 | 1 = 1783612333
  const seqNum = 1783612326;
  const capturedLockPayload =
    "ff096a0003000240230c1fa86e364a2a504c67567748f93d3bfff5318a8baadadddbf6909827400b12525531a0" +
    "5628097cf1c49e9928b5a0f2d9e11648e42aabc55432c799248c26d4ab2339a65c622e5119f4689982b80b95b0c" +
    "5554d07385bc3064b8a5f2cbb87b387";

  it("reproduces the captured unlock frame byte-for-byte", () => {
    const cmd = buildFf09Frame({
      engage: false, // unlock
      adminUserId,
      username,
      shortUserId,
      deviceSn,
      unixTime,
      nonce,
      seqNum,
    });
    expect(cmd.lockPayload).toBe(capturedLockPayload);
    expect(cmd.time).toBe(1783612333);
    expect(cmd.seqNum).toBe(seqNum);
    // The builder returns the envelope apiCommand for this frame — the transport carries it through
    // without knowing the pairing (see Ff09Frame.apiCommand).
    expect(cmd.apiCommand).toBe(LOCK_API_COMMAND.ON_OFF_LOCK);
  });

  it("encodes lock vs unlock with the A3 lock byte (0 vs 1) and re-derives the key per time", () => {
    const base = {
      adminUserId,
      username,
      shortUserId,
      deviceSn,
      unixTime,
      nonce,
    };
    const lock = buildFf09Frame({ ...base, engage: true });
    const unlock = buildFf09Frame({ ...base, engage: false });
    // Same key/IV/time, only the lockByte differs → the frames differ.
    expect(lock.lockPayload).not.toBe(unlock.lockPayload);
    // cmdEnc = 0x4000 | 35 = 0x4023, right after the 7-byte header (ff09|size2|03 00 02) = hex offset 14.
    expect(lock.lockPayload.slice(14, 18)).toBe("4023");
  });

  it("frames carry the ff09 magic, a self-consistent size, and a valid XOR checksum", () => {
    const { lockPayload } = buildFf09Frame({
      engage: true,
      adminUserId,
      username,
      shortUserId,
      deviceSn,
    });
    const buf = Buffer.from(lockPayload, "hex");
    expect(buf.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(buf.readUInt16LE(2)).toBe(buf.length); // size = total frame length
    let xor = 0;
    for (const b of buf.subarray(0, buf.length - 1)) xor ^= b;
    expect(buf[buf.length - 1]).toBe(xor); // trailing checksum
  });

  it("rejects missing identity loudly (fire-and-forget wire can't surface a bad frame)", () => {
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId: "",
        username,
        shortUserId,
        deviceSn,
      }),
    ).toThrow(/adminUserId/);
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId,
        username,
        shortUserId,
        deviceSn: "",
      }),
    ).toThrow(/deviceSn/);
  });

  it("rejects a deviceSn too long for the 16-byte IV instead of silently truncating it", () => {
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId,
        username,
        shortUserId,
        deviceSn: "T8531K00000000001", // 17 chars — one over the IV size
      }),
    ).toThrow(/deviceSn too long/);
  });

  it("rejects a TLV field over 255 bytes instead of silently wrapping the 1-byte length", () => {
    expect(() =>
      buildFf09Frame({
        engage: true,
        adminUserId,
        username: "x".repeat(256), // the A4 field — over a single length byte's range
        shortUserId,
        deviceSn,
      }),
    ).toThrow(/TLV field too long/);
  });

  it("rejects a shortUserId that isn't even-length hex instead of silently mangling it", () => {
    // Buffer.from(str, "hex") drops a trailing odd character and returns an EMPTY buffer on non-hex
    // input, rather than throwing — both would otherwise fail silent on this fire-and-forget wire.
    // (An empty shortUserId is caught earlier by the "required unless omitUserFields" guard instead.)
    for (const bad of ["003", "zz03"]) {
      expect(() =>
        buildFf09Frame({
          engage: true,
          adminUserId,
          username,
          shortUserId: bad,
          deviceSn,
        }),
      ).toThrow(/shortUserId must be an even-length hex string/);
    }
  });
});

describe("buildFf09CommandFrame / ff09FrameCode", () => {
  const ADMIN = "0".repeat(40);
  const SN = "T85L0K0000000000";

  it("frames any opcode as [A1 time][A2 account id] + the caller's fields, carrying its apiCommand", () => {
    const frame = buildFf09CommandFrame({
      commandCode: 0x24,
      apiCommand: 6012,
      adminUserId: ADMIN,
      deviceSn: SN,
      fields: [Buffer.from("13572468", "ascii"), Buffer.from([4])],
      unixTime: 1_700_000_000,
      nonce: 7,
      seqNum: 3,
    });

    expect(frame.apiCommand).toBe(6012);
    expect(frame.seqNum).toBe(3);
    expect(frame.time).toBe((1_700_000_000 | 7) >>> 0);
    expect(ff09FrameCode(frame.lockPayload)).toBe(0x24);
    expect(frame.lockPayload.slice(14, 18)).toBe("4024");
    const plain = decryptFf09Frame({
      lockPayload: frame.lockPayload,
      keyTime: frame.time,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    const tlv = walkFf09Tlv(plain, 0, plain.length);
    expect(tlv.get(0xa1)?.readUInt32LE(0)).toBe(1_700_000_000);
    expect(tlv.get(0xa2)?.toString("ascii")).toBe(ADMIN);
    expect(tlv.get(0xa3)?.toString("ascii")).toBe("13572468");
    expect(tlv.get(0xa4)?.toString("hex")).toBe("04");
    expect(tlv.size).toBe(4);
  });

  it("reads a reply's opcode under its own flags, the same as its request's, and nothing from a non-ff09 payload", () => {
    expect(ff09FrameCode("ff091a0003000248240000")).toBe(0x24);
    expect(ff09FrameCode("ff091400030102004a00")).toBe(0x4a);
    expect(ff09FrameCode("00112233445566778899")).toBeUndefined();
  });
});
