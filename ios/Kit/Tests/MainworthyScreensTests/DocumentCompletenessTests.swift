import Foundation
import MainworthyClient
import TestSupport
import Testing
@testable import MainworthyScreens

final class IncompletePart: Transport {
 let inner = URLSessionTransport()
 let field: String
 let section: String
 init(_ field:String, section:String="body") {self.field=field;self.section=section}
 func send(_ request:URLRequest) async throws -> (Data,HTTPURLResponse) {
  let (data,response)=try await inner.send(request)
  guard request.url?.lastPathComponent=="get" else{return (data,response)}
  var envelope=try JSONDecoder().decode(JSONValue.self,from:data).object!
  envelope["result"] = .array((envelope["result"]?.array ?? []).map { row in
   var row=row.object!
   if let edits=row["edits"]?.array {row["edits"] = .array(edits.map { part in
    var part=part.object!
    if section=="placement" {
     if field=="badTags" {part["tags"] = [77]} else {part.removeValue(forKey:field)}
    } else if var body=part[section]?.object {
     if field.hasPrefix("step.") {
      body["steps"] = .array((body["steps"]?.array ?? []).map { step in var step=step.object!;step.removeValue(forKey:String(field.dropFirst(5)));return .object(step)})
     } else {body.removeValue(forKey:field)}
     part[section] = .object(body)
    }
    return .object(part)
   })}
   return .object(row)
  })
  return (try JSONEncoder().encode(JSONValue.object(envelope)),response)
 }
 func lines(_ request:URLRequest) async throws -> (AsyncThrowingStream<String,any Error>,HTTPURLResponse){try await inner.lines(request)}
}
@Suite("A document that lacks a part, or holds a part of another type, is not shown", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`")) @MainActor
struct ReviewFifth {
 @Test func everyPart() async throws {
  for (section,fields) in [("body",["fields","steps","methods","automate","pre","title","unused"]),("current",["fields","steps","methods","automate","pre","title"]),("placement",["folder","tags","covers","badTags"])] {
   for field in fields {
    let key=try await Live.project(strict:true)
    let owner=Live.server();_=try await owner.signIn(Live.owner)
    let title="Completeness \(section) \(field)"
    let edit:JSONValue=section=="current"
      ? ["op":"edit","case":"C-1","base":1,"body":["title":.string(title),"fields":["risk":"high"]]]
      : ["op":"create","folder":"Review/Folder","tags":["hidden-tag"],"covers":["REQ-1"],"body":["title":.string(title),"pre":"Signed in","methods":["human","auto"],"automate":"wanted","fields":["risk":"high"],"steps":[["id":"probe","action":"Do it","expected":"Works"]]]]
    let made:JSONValue=try await owner.write("propose",in:key,["reason":"Review fixture","edits":[edit]])
    let server=Server(instance:Live.instance,secrets:MemoryStore(),transport:IncompletePart(field,section:section));_=try await server.signIn(Live.owner)
    let screen=QueueScreen(project:try await server.project(key));await screen.show(.open,filter:nil)
    let q=try #require(screen.questions.first {$0.ref==made["question"]?.string});await screen.readDocuments(of:q)
    let complete=field=="unused"
    #expect(screen.isShown(q) == complete)
    if complete {
     guard case .read(let docs)=screen.documents(of:q) else {Issue.record("complete document not read");return}
     #expect(docs.count == 1)
     let doc=try #require(docs.first)
     #expect(doc.after.title == "Completeness body unused")
     #expect(doc.after.steps == [Step(id:"probe",action:"Do it",expected:"Works")])
     #expect(doc.placement == EditedCase.Placement(folder:"Review/Folder",tags:["hidden-tag"],covers:["REQ-1"]))
    }
    let accepted=await screen.answer(q,with:try #require(q.choices.first {$0.answer=="accept"}),reason:"Read all visible content")
    let live=try #require(try await owner.project(key).question(q.ref))
    #expect(accepted == complete)
    #expect(live.isOpen == !complete)
    if complete {#expect(live.decision?.label == "Accept")}
   }
  }
 }
 @Test func stepParts() async throws {
  for field in ["step.id","step.action","step.expected"] {
   let key=try await Live.project(strict:true);let owner=Live.server();_=try await owner.signIn(Live.owner)
   let made:JSONValue=try await owner.write("propose",in:key,["reason":"Review fixture","edits":[["op":"create","body":["title":"Step completeness","steps":[["id":"probe","action":"Do it","expected":"Hidden expected result"]]]]]])
   let server=Server(instance:Live.instance,secrets:MemoryStore(),transport:IncompletePart(field));_=try await server.signIn(Live.owner)
   let screen=QueueScreen(project:try await server.project(key));await screen.show(.open,filter:nil)
   let q=try #require(screen.questions.first {$0.ref==made["question"]?.string});await screen.readDocuments(of:q)
   let shown=screen.isShown(q)
   let accepted=await screen.answer(q,with:try #require(q.choices.first {$0.answer=="accept"}),reason:"Reviewed visible content")
   #expect(!shown && !accepted)
  }
 }
 @Test func longProposal() async throws {
  let key=try await Live.project(strict:true);let owner=Live.server();_=try await owner.signIn(Live.owner)
  let edits:[JSONValue]=(0..<21).map {i in ["op":"create","outline":.string("Long case \(i)")]}
  let made:JSONValue=try await owner.write("propose",in:key,["reason":"Review fixture","edits":.array(edits)])
  let screen=QueueScreen(project:try await owner.project(key));await screen.show(.open,filter:nil)
  let q=try #require(screen.questions.first {$0.ref==made["question"]?.string});await screen.readDocuments(of:q)
  guard case .proposal(let edit)=q.evidence else {Issue.record("not proposal");return}
  #expect(edit.notShown == nil && !screen.isShown(q))
  #expect(q.choices.map(\.takes) == [.nothing, .nothing])
  guard case .read(let documents)=screen.documents(of:q) else {Issue.record("large proposal was not read");return}
  #expect(documents.count == 21)
  #expect(Set(documents.map { $0.after.title }) == Set((0..<21).map { "Long case \($0)" }))
  for document in documents {screen.showProposalRange(of:q,document:document.id,height:100,top:0,bottom:100)}
  #expect(screen.isShown(q))
 }
 @Test func standaloneState() async throws {
  let key=try await Live.project();let owner=Live.server();_=try await owner.signIn(Live.owner)
  let screen=QueueScreen(project:try await owner.project(key));await screen.show(.open,filter:nil)
  let original=try #require(screen.questions.first {$0.kind == .failure});await screen.open(original.ref)
  await screen.show(.decided,filter:nil);let open=try #require(screen.current(original.ref))
  #expect(open.isOpen && open.standing == .counts)
  let other=try await Live.signedIn().project(key);_=try await other.answer(open,with:try #require(open.choices.first {$0.answer=="infra"}))
  await screen.refresh();let decided=try #require(screen.current(original.ref))
  #expect(!decided.isOpen && decided.decision?.label=="Infrastructure")
  await screen.show(.open,filter:nil);#expect(screen.current(original.ref)?.decision != nil)
  screen.close(original.ref);#expect(screen.current(original.ref)==nil)
 }
}
