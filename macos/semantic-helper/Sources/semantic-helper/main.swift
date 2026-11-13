// Team Work's semantic search helper: runs EmbeddingGemma 2 (Core AI, Neural Engine) for the backend.
//
// The backend owns this process. It writes one JSON request per line on stdin and reads one JSON reply per line
// on stdout; stdout carries nothing else. stderr carries only structured diagnostics (one JSON object per line,
// never any input text), which the backend copies into backend.log. Requests run one at a time, in order: the
// backend decides what goes first.
//
// Requests:
//   {"id":1,"op":"load","bundle":"/path/model"}
//   {"id":2,"op":"embed","texts":["task: code retrieval | query: ..."],"maxTokens":2048}
//   {"id":3,"op":"validate","reference":"/path/smoke-reference.json","tokenizerCases":"/path/tokenizer-cases.json"}
//   {"id":4,"op":"memory"}
// Replies: {"id":1,"ok":true,...} or {"id":1,"ok":false,"error":"..."}. An error thrown inside is given as its
// type, domain and code only ("<type> domain=<domain> code=<n>"): its message could quote input.
// embed gives each text its full token count, with <bos> and <eos>; a text over maxTokens gets "tooLong":true and
// no vector, and is never cut short.
import CoreAI
import Darwin
import Foundation

struct Request: Decodable {
    let id: Int
    let op: String
    let bundle: String?
    let texts: [String]?
    let maxTokens: Int?
    let reference: String?
    let tokenizerCases: String?
}

let out = FileHandle.standardOutput
let err = FileHandle.standardError

func write(_ handle: FileHandle, _ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    handle.write(data)
}

func reply(_ id: Int, _ fields: [String: Any]) {
    var object = fields
    object["id"] = id
    object["ok"] = true
    write(out, object)
}

func failure(_ id: Int, _ message: String) {
    write(out, ["id": id, "ok": false, "error": String(message.prefix(300))])
}

func errorKind(_ error: Error) -> String {
    let ns = error as NSError
    return "\(String(reflecting: type(of: error))) domain=\(ns.domain) code=\(ns.code)"
}

// diag is a diagnostic line on stderr: an event name and numbers or fixed words, never input text.
func diag(_ event: String, _ fields: [String: Any] = [:]) {
    var object = fields
    object["event"] = event
    write(err, object)
}

func residentBytes() -> Int {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return result == KERN_SUCCESS ? Int(info.phys_footprint) : -1
}

func cosine(_ a: [Float], _ b: [Float]) -> Double {
    var dot = 0.0, na = 0.0, nb = 0.0
    for i in 0..<min(a.count, b.count) {
        dot += Double(a[i]) * Double(b[i])
        na += Double(a[i]) * Double(a[i])
        nb += Double(b[i]) * Double(b[i])
    }
    return dot / max(sqrt(na) * sqrt(nb), 1e-12)
}

struct SmokeFile: Decodable {
    struct Case: Decodable { let kind: String; let text: String; let embedding: [Float] }
    let threshold_cosine: Double
    let cases: [Case]?
}

struct TokenizerCase: Decodable { let kind: String; let text: String; let ids: [Int32] }

var model: EmbeddingGemma2?

// Leftover compiled-graph copies of this process, if the model is still loaded when stdin closes.
func cleanup() {
    model = nil
    let removed = EmbeddingGemma2.removeOwnMPSGraphTempFiles()
    diag("cleanup", ["folders": removed.folders, "bytes": removed.bytes])
}

signal(SIGPIPE, SIG_IGN)
diag("start", ["pid": Int(getpid()), "memory": residentBytes()])

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let req = try? JSONDecoder().decode(Request.self, from: data) else {
        diag("bad_request", ["bytes": line.utf8.count])
        continue
    }
    do {
        switch req.op {
        case "load":
            guard let path = req.bundle else { failure(req.id, "bundle is required"); continue }
            let t0 = Date()
            diag("compile_start")
            let m = try await EmbeddingGemma2(bundle: URL(fileURLWithPath: path), compute: .neuralEngine, loadVision: false, loadAudio: false)
            let loaded = Date().timeIntervalSince(t0)
            let warm = try await m.prewarm()
            model = m
            diag("compile_done", ["seconds": loaded, "prewarmSeconds": warm, "memory": residentBytes()])
            reply(req.id, ["loadSeconds": m.loadSeconds, "tokenizerSeconds": m.tokenizerLoadSeconds, "prewarmSeconds": warm,
                           "buckets": m.buckets, "dim": m.config.embedding_dim, "maxTokens": m.buckets.last ?? 0])
        case "embed":
            guard let m = model else { failure(req.id, "model is not loaded"); continue }
            let limit = min(req.maxTokens ?? (m.buckets.last ?? 0), m.buckets.last ?? 0)
            var results: [[String: Any]] = []
            let t0 = Date()
            for text in req.texts ?? [] {
                // The whole text with <bos>/<eos>, never the truncating tokenize()
                let ids = m.tokenizer.encodeWithSpecials(text)
                if ids.count > limit {
                    results.append(["tokens": ids.count, "tooLong": true])
                    continue
                }
                let v = try await m.embed(ids: ids)
                guard v.allSatisfy({ $0.isFinite }) else { throw EmbedderError(description: "embedding has a non-finite value") }
                results.append(["tokens": ids.count, "vector": v])
            }
            reply(req.id, ["results": results, "seconds": Date().timeIntervalSince(t0)])
        case "validate":
            guard let m = model, let refPath = req.reference, let casesPath = req.tokenizerCases else {
                failure(req.id, "model, reference and tokenizerCases are required"); continue
            }
            let t0 = Date()
            let cases = try JSONDecoder().decode([TokenizerCase].self, from: Data(contentsOf: URL(fileURLWithPath: casesPath)))
            let prefixes = ["q": "task: search result | query: ", "d": "title: none | text: ", "raw": ""]
            var same = 0
            for c in cases where m.tokenizer.encodeWithSpecials((prefixes[c.kind] ?? "") + c.text) == c.ids { same += 1 }
            let ref = try JSONDecoder().decode(SmokeFile.self, from: Data(contentsOf: URL(fileURLWithPath: refPath)))
            var least = 1.0, count = 0, dims = true
            for c in ref.cases ?? [] {
                let ids = m.tokenizer.encodeWithSpecials((m.config.prompts[c.kind] ?? "") + c.text)
                guard ids.count <= (m.buckets.last ?? 0) else { continue }
                let v = try await m.embed(ids: ids)
                dims = dims && v.count == c.embedding.count && v.allSatisfy { $0.isFinite }
                least = min(least, cosine(v, c.embedding))
                count += 1
            }
            reply(req.id, ["tokenizerSame": same, "tokenizerCases": cases.count, "smokeCases": count, "minCosine": least,
                           "threshold": ref.threshold_cosine, "dimensionsOK": dims, "seconds": Date().timeIntervalSince(t0)])
        case "memory":
            reply(req.id, ["bytes": residentBytes()])
        default:
            failure(req.id, "unknown op")
        }
    } catch {
        diag("error", ["op": req.op])
        failure(req.id, errorKind(error))
    }
}
cleanup()
diag("exit")
