import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetSocialForTests,
  requestFriend,
  acceptFriend,
  declineFriend,
  cancelFriendRequest,
  removeFriend,
  sendDM,
  postWall,
  getWallFeed,
  listFriends,
  listPending,
  getUnreadDMs,
  getProfile,
  getSocialSnapshot,
  markDMsRead,
} from "./social.js";

describe("social graph", () => {
  beforeEach(() => _resetSocialForTests());

  it("friend request and accept", () => {
    requestFriend("Alice", "Bob");
    expect(listFriends("Alice")).toEqual([]);
    acceptFriend("Bob", "Alice");
    expect(listFriends("Alice")).toContain("Bob");
    expect(listFriends("Bob")).toContain("Alice");
  });

  it("mutual request auto-accepts", () => {
    expect(requestFriend("Alice", "Bob").ok).toBe(true);
    // Bob requests Alice back → should become friends immediately
    const r = requestFriend("Bob", "Alice");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/now friends/i);
    expect(listFriends("Alice")).toContain("Bob");
    expect(listFriends("Bob")).toContain("Alice");
    expect(listPending("Alice").in).toEqual([]);
    expect(listPending("Alice").out).toEqual([]);
    expect(listPending("Bob").in).toEqual([]);
    expect(listPending("Bob").out).toEqual([]);
  });

  it("decline inbound friend request", () => {
    requestFriend("Alice", "Bob");
    const r = declineFriend("Bob", "Alice");
    expect(r.ok).toBe(true);
    expect(listFriends("Alice")).toEqual([]);
    expect(listFriends("Bob")).toEqual([]);
    expect(listPending("Bob").in).toEqual([]);
    expect(listPending("Alice").out).toEqual([]);
  });

  it("cancel outbound friend request", () => {
    requestFriend("Alice", "Bob");
    const r = cancelFriendRequest("Alice", "Bob");
    expect(r.ok).toBe(true);
    expect(listPending("Alice").out).toEqual([]);
    expect(listPending("Bob").in).toEqual([]);
  });

  it("remove friend both sides", () => {
    requestFriend("Alice", "Bob");
    acceptFriend("Bob", "Alice");
    expect(removeFriend("Alice", "Bob").ok).toBe(true);
    expect(listFriends("Alice")).toEqual([]);
    expect(listFriends("Bob")).toEqual([]);
  });

  it("self-friend rejected", () => {
    expect(requestFriend("Alice", "Alice").ok).toBe(false);
  });

  it("keeps read-only lookups side-effect free", () => {
    expect(listFriends("UnknownReader")).toEqual([]);
    expect(listPending("UnknownReader")).toEqual({ in: [], out: [] });
    expect(getSocialSnapshot("UnknownReader")).toMatchObject({ friends: [] });
    expect(getProfile("UnknownReader")).toBeNull();
  });

  it("duplicate pending rejected", () => {
    requestFriend("Alice", "Bob");
    const r = requestFriend("Alice", "Bob");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already pending/i);
  });

  it("dm and wall feed", () => {
    requestFriend("Alice", "Bob");
    acceptFriend("Bob", "Alice");
    sendDM("Alice", "Bob", "meet at stairs");
    postWall("Alice", "depth 3!");
    const feed = getWallFeed("Bob");
    expect(feed[0]?.text).toBe("depth 3!");
    expect(getUnreadDMs("Bob").length).toBe(1);
    markDMsRead("Bob", "Alice");
    expect(getUnreadDMs("Bob").length).toBe(0);
  });
});
