import Foundation
import Vision
import AppKit
let args = CommandLine.arguments
guard args.count == 3, let img = NSImage(contentsOfFile: args[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("usage: cutout in out.png"); exit(1) }
let req = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cg)
try handler.perform([req])
guard let r = req.results?.first else { print("no foreground"); exit(2) }
let buf = try r.generateMaskedImage(ofInstances: r.allInstances, from: handler, croppedToInstancesExtent: true)
let ci = CIImage(cvPixelBuffer: buf)
let rep = NSBitmapImageRep(ciImage: ci)
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("ok \(rep.pixelsWide)x\(rep.pixelsHigh)")
