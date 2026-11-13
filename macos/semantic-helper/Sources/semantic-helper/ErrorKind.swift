import Foundation

// Domains an error is reported with as they are; any other is "other". The backend keeps only these too
// (helperErrorText in backend/internal/semantic/helper.go).
let knownDomains: Set<String> = [NSCocoaErrorDomain, NSPOSIXErrorDomain, NSOSStatusErrorDomain, NSMachErrorDomain, NSURLErrorDomain]

/// errorKind is how an error thrown inside the helper is reported: "kind=<kind> domain=<domain> code=<n>", with a
/// fixed kind and a known domain or "other". Its message, type name and domain could quote input, so none of them
/// is given as is.
func errorKind(_ error: Error) -> String {
    let ns = error as NSError
    let domain = knownDomains.contains(ns.domain) ? ns.domain : "other"
    return "kind=\(kindOf(String(reflecting: type(of: error)))) domain=\(domain) code=\(ns.code)"
}

/// kindOf names the kind of an error by its type: one of a fixed few words.
func kindOf(_ type: String) -> String {
    switch type {
    case "NSError": return "nserror"
    case "Swift.DecodingError": return "decoding"
    case "Swift.EncodingError": return "encoding"
    case "Swift.CancellationError": return "cancelled"
    case _ where type.hasPrefix("CoreAI."): return "coreai"
    case _ where type.hasSuffix(".EmbedderError"): return "embedder"
    default: return "other"
    }
}
