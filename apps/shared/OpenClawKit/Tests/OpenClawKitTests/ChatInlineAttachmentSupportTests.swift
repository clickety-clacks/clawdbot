import OpenClawKit
import Foundation
import Testing
@testable import OpenClawChatUI

@Suite struct ChatInlineAttachmentSupportTests {
    @Test("Inline attachment filter includes document blocks (terminal + document)")
    func inlineAttachmentFilterIncludesDocumentBlocks() {
        let blocks: [OpenClawChatMessageContent] = [
            self.content(type: "text", text: "hello"),
            self.content(
                type: "document",
                mimeType: "application/vnd.clawline.terminal-session+json",
                fileName: "terminal.json"),
            self.content(type: "document", mimeType: "application/pdf", fileName: "report.pdf"),
            self.content(type: "attachment", fileName: "fallback.bin"),
            self.content(type: "toolCall", name: "shell", arguments: AnyCodable(["cmd": AnyCodable("ls")])),
        ]

        let inline = ChatInlineAttachmentSupport.inlineAttachments(from: blocks)
        #expect(inline.count == 3)
        #expect(ChatInlineAttachmentSupport.kind(for: inline[0]) == .terminalSession)
        #expect(ChatInlineAttachmentSupport.kind(for: inline[1]) == .document)
        #expect(ChatInlineAttachmentSupport.kind(for: inline[2]) == .file)
    }

    @Test("Terminal MIME with parameters still classifies as terminal session")
    func terminalMimeWithParametersClassifiesAsTerminalSession() {
        let block = self.content(
            type: "document",
            mimeType: "Application/Vnd.Clawline.Terminal-Session+JSON; charset=utf-8")

        #expect(ChatInlineAttachmentSupport.kind(for: block) == .terminalSession)
        #expect(ChatInlineAttachmentSupport.iconName(for: block) == "terminal")
    }

    @Test("Interactive document title is pulled from descriptor metadata")
    func interactiveDocumentTitleComesFromMetadata() {
        let descriptor = AnyCodable([
            "metadata": AnyCodable([
                "title": AnyCodable("Build Dashboard"),
            ]),
        ])
        let block = self.content(
            type: "document",
            mimeType: "application/vnd.clawline.interactive-html+json",
            fileName: "fallback.html",
            content: descriptor)

        #expect(ChatInlineAttachmentSupport.kind(for: block) == .interactiveHTML)
        #expect(ChatInlineAttachmentSupport.displayName(for: block) == "Build Dashboard")
        #expect(ChatInlineAttachmentSupport.subtitle(for: block) == "Interactive document")
    }

    private func content(
        type: String,
        text: String? = nil,
        mimeType: String? = nil,
        fileName: String? = nil,
        content: AnyCodable? = nil,
        name: String? = nil,
        arguments: AnyCodable? = nil) -> OpenClawChatMessageContent
    {
        OpenClawChatMessageContent(
            type: type,
            text: text,
            thinking: nil,
            thinkingSignature: nil,
            mimeType: mimeType,
            fileName: fileName,
            content: content,
            id: nil,
            name: name,
            arguments: arguments)
    }
}
