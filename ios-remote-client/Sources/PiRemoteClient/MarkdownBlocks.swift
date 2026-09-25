import Foundation

/// Block-level structure SwiftUI `Text` cannot render from inline Markdown alone.
/// Inline markup inside paragraphs and headings is left for `AttributedString`.
public enum MarkdownBlock: Equatable, Sendable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case code(language: String?, code: String)
}

/// Splits assistant Markdown into paragraphs, ATX headings, and fenced code.
/// An unterminated fence yields a code block so streaming output renders as code
/// before its closing fence arrives.
public func parseMarkdownBlocks(_ markdown: String) -> [MarkdownBlock] {
  var blocks: [MarkdownBlock] = []
  var paragraph: [Substring] = []
  var fence: (marker: String, language: String?, lines: [Substring])?

  func flushParagraph() {
    guard !paragraph.isEmpty else { return }
    blocks.append(.paragraph(paragraph.joined(separator: "\n")))
    paragraph.removeAll()
  }

  for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if let open = fence {
      if isClosingFence(trimmed, for: open.marker) {
        blocks.append(.code(language: open.language, code: open.lines.joined(separator: "\n")))
        fence = nil
      } else {
        fence?.lines.append(line)
      }
      continue
    }

    if let marker = fenceMarker(trimmed) {
      flushParagraph()
      let language = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
      fence = (marker, language.isEmpty ? nil : language, [])
    } else if let heading = heading(trimmed) {
      flushParagraph()
      blocks.append(heading)
    } else if trimmed.isEmpty {
      flushParagraph()
    } else {
      paragraph.append(line)
    }
  }

  flushParagraph()
  if let open = fence {
    blocks.append(.code(language: open.language, code: open.lines.joined(separator: "\n")))
  }
  return blocks
}

private func fenceMarker(_ line: String) -> String? {
  for character in ["`", "~"] {
    let run = line.prefix { String($0) == character }
    if run.count >= 3 {
      return String(run)
    }
  }
  return nil
}

private func isClosingFence(_ line: String, for marker: String) -> Bool {
  guard let closing = fenceMarker(line) else { return false }
  return closing.first == marker.first && closing.count >= marker.count
    && closing.count == line.count
}

private func heading(_ line: String) -> MarkdownBlock? {
  let hashes = line.prefix { $0 == "#" }
  guard (1...6).contains(hashes.count) else { return nil }
  let rest = line.dropFirst(hashes.count)
  guard rest.first == " " else { return nil }
  return .heading(level: hashes.count, text: rest.trimmingCharacters(in: .whitespaces))
}
