import XCTest
@testable import OpenClawChatUI

final class ChatScrollStateStoreTests: XCTestCase {
    func testRoundTripSaveLoadAndClear() throws {
        let suite = "ChatScrollStateStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let key = "session-abc"
        XCTAssertNil(ChatScrollStateStore.load(sessionKey: key, defaults: defaults))

        let state = ChatScrollState(
            isPinnedToBottom: false,
            anchorMessageID: UUID().uuidString,
            updatedAtMs: 1_000)

        ChatScrollStateStore.save(state, sessionKey: key, defaults: defaults)
        XCTAssertEqual(ChatScrollStateStore.load(sessionKey: key, defaults: defaults), state)

        ChatScrollStateStore.clear(sessionKey: key, defaults: defaults)
        XCTAssertNil(ChatScrollStateStore.load(sessionKey: key, defaults: defaults))
    }
}

