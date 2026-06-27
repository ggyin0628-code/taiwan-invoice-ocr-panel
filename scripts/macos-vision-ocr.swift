import AppKit
import Foundation
import Vision

struct Word: Encodable {
  let text: String
  let confidence: Float
  let left: Int
  let top: Int
  let width: Int
  let height: Int
}

struct Output: Encodable {
  let ok: Bool
  let text: String
  let confidence: Float
  let words: [Word]
  let error: String?
}

func emit(_ output: Output) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  if let data = try? encoder.encode(output), let string = String(data: data, encoding: .utf8) {
    print(string)
  } else {
    print("{\"ok\":false,\"text\":\"\",\"confidence\":0,\"words\":[],\"error\":\"json encode failed\"}")
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  emit(Output(ok: false, text: "", confidence: 0, words: [], error: "missing image path"))
  exit(1)
}

let imagePath = args[1]
let url = URL(fileURLWithPath: imagePath)
guard let image = NSImage(contentsOf: url) else {
  emit(Output(ok: false, text: "", confidence: 0, words: [], error: "image open failed"))
  exit(1)
}

var rect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
  emit(Output(ok: false, text: "", confidence: 0, words: [], error: "cg image failed"))
  exit(1)
}

let width = cgImage.width
let height = cgImage.height
var requestError: Error?
var recognized: [Word] = []

let request = VNRecognizeTextRequest { request, error in
  requestError = error
  guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
  for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    let left = Int((box.minX * CGFloat(width)).rounded())
    let top = Int(((1 - box.maxY) * CGFloat(height)).rounded())
    let wordWidth = Int((box.width * CGFloat(width)).rounded())
    let wordHeight = Int((box.height * CGFloat(height)).rounded())
    recognized.append(Word(
      text: candidate.string,
      confidence: candidate.confidence,
      left: max(0, left),
      top: max(0, top),
      width: max(1, wordWidth),
      height: max(1, wordHeight)
    ))
  }
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.minimumTextHeight = 0.01
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
  try handler.perform([request])
} catch {
  emit(Output(ok: false, text: "", confidence: 0, words: [], error: error.localizedDescription))
  exit(1)
}

if let requestError {
  emit(Output(ok: false, text: "", confidence: 0, words: [], error: requestError.localizedDescription))
  exit(1)
}

let text = recognized.map { $0.text }.joined(separator: "\n")
let avg = recognized.isEmpty ? 0 : recognized.map { $0.confidence }.reduce(0, +) / Float(recognized.count)
emit(Output(ok: true, text: text, confidence: avg, words: recognized, error: nil))
