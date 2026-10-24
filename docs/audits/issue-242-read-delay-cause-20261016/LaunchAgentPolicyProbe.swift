// Isolated diagnostic: generate from the actual CodexBridgeKit implementation.
// Input JSON selects a unique fixture label and private paths; never use the installed label.
import Foundation
@testable import CodexBridgeKit
let configURL = URL(fileURLWithPath: CommandLine.arguments[1])
let config = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: Any]
var plist = HelperBootstrap.launchAgentPropertyList(
    programArguments: config["arguments"] as! [String],
    workingDirectory: URL(fileURLWithPath: config["workingDirectory"] as! String),
    environment: config["environment"] as! [String: String]
)
plist["Label"] = config["label"]
plist["StandardOutPath"] = config["stdout"]
plist["StandardErrorPath"] = config["stderr"]
if let policy = config["baselinePolicy"] { plist["ProcessType"] = policy }
let output = URL(fileURLWithPath: config["output"] as! String)
try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: output)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
