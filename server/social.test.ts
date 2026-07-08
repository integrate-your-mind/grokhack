import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetSocialForTests,
  requestFriend,
  acceptFriend,
  sendDM,
  postWall,
  getWallFeed,
  listFriends,
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

  it("dm and wall feed", () => {
    requestFriend("Alice", "Bob");
    acceptFriend("Bob", "Alice");
    sendDM("Alice", "Bob", "meet at stairs");
    postWall("Alice", "depth 3!");
    const feed = getWallFeed("Bob");
    expect(feed[0]?.text).toBe("depth 3!");
  });
});