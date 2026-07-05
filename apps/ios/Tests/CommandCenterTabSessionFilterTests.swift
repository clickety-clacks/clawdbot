import Testing
import Foundation
@testable import OpenClaw

struct CommandCenterTabSessionFilterTests {
    @Test func `hides direct agent device sessions`() {
        #expect(!CommandCenterTab.isRecentChatSession("main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:rust-claw:main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:node-0b88d67b7e42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work", defaultSessionKey: "work"))
        #expect(!CommandCenterTab.isRecentChatSession("main", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("global", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("node-0b88d67b7e42", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("work", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:main:thread:42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:support:main:thread:1234:42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession(
            "agent:main:node-0b88d67b7e42:thread:42",
            defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work:thread:42", defaultSessionKey: "work"))
        #expect(!CommandCenterTab.isRecentChatSession(
            "agent:main:work:thread:42",
            defaultSessionKey: "agent:rust-claw:work"))
    }

    @Test func `keeps agent scoped channel and cron sessions`() {
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:main:signal:direct:+15555550123",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:rust-claw:mattermost:channel:abc123",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:rust-claw:cron:3cd2eb6f-b8a5-4db7-b74a-f6a3f7eab3d3",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:main:slack:channel:c1:thread:123",
            defaultSessionKey: "main"))
    }

    @Test func `fresh session update labels show seconds`() {
        let now = Date(timeIntervalSince1970: 1_000)
        #expect(CommandCenterTab.relativeTimeText(
            forMilliseconds: now.timeIntervalSince1970 * 1000,
            relativeTo: now) == "0s ago")
        #expect(CommandCenterTab.relativeTimeText(
            forMilliseconds: now.addingTimeInterval(-7).timeIntervalSince1970 * 1000,
            relativeTo: now) == "7s ago")
        #expect(CommandCenterTab.relativeTimeText(
            forMilliseconds: now.addingTimeInterval(-59).timeIntervalSince1970 * 1000,
            relativeTo: now) == "59s ago")
    }

    @Test func `session update labels roll into minute wording`() {
        let now = Date(timeIntervalSince1970: 1_000)
        let updatedAt = now.addingTimeInterval(-60).timeIntervalSince1970 * 1000
        let expected = Self.existingRelativeTimeText(
            forMilliseconds: updatedAt,
            relativeTo: now)
        #expect(CommandCenterTab.relativeTimeText(
            forMilliseconds: updatedAt,
            relativeTo: now) == expected)
    }

    @Test func `older session update labels preserve existing friendly dates`() {
        let now = Date(timeIntervalSince1970: 1_000)
        for age in [2 * 60, 60 * 60, 3 * 60 * 60, 26 * 60 * 60] {
            let updatedAt = now.addingTimeInterval(TimeInterval(-age)).timeIntervalSince1970 * 1000
            #expect(CommandCenterTab.relativeTimeText(
                forMilliseconds: updatedAt,
                relativeTo: now) == Self.existingRelativeTimeText(
                    forMilliseconds: updatedAt,
                    relativeTo: now))
        }
    }

    private static func existingRelativeTimeText(
        forMilliseconds milliseconds: Double,
        relativeTo now: Date) -> String
    {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }
}
