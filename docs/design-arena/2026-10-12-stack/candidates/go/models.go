package main

import "encoding/json"

type Step struct {
	ID       string  `json:"id" jsonschema:"Stable step identifier"`
	Action   string  `json:"action"`
	Expected *string `json:"expected"`
}
type Method struct {
	M string `json:"m"`
}
type Intent struct {
	Automate string `json:"automate"`
}
type Body struct {
	Title   string            `json:"title"`
	Pre     string            `json:"pre"`
	Steps   []Step            `json:"steps"`
	Methods []Method          `json:"methods"`
	Intent  Intent            `json:"intent"`
	Fields  map[string]string `json:"fields"`
}
type GetInput struct {
	Ref int64 `json:"ref" jsonschema:"Project 1 case reference number"`
}
type CaseOutput struct {
	ID      int64  `json:"id"`
	Project int64  `json:"project"`
	Ref     int64  `json:"ref"`
	Folder  int64  `json:"folder"`
	Rank    int64  `json:"rank"`
	Title   string `json:"title"`
	Head    int64  `json:"head"`
	Hash    string `json:"hash"`
	State   string `json:"state"`
	Rev     int64  `json:"rev"`
	Body    Body   `json:"body"`
}
type SaveInput struct {
	Command string `json:"command" jsonschema:"Client generated idempotency identifier"`
	Ref     int64  `json:"ref"`
	Base    int64  `json:"base" jsonschema:"Expected current version, rejected if stale"`
	Body    Body   `json:"body"`
}
type SaveOutput struct {
	Case     int64  `json:"case"`
	Version  int64  `json:"version"`
	Sequence int64  `json:"seq"`
	Question int64  `json:"question"`
	Decision int64  `json:"decision"`
	Hash     string `json:"hash"`
}
type ResultInput struct {
	Key      string `json:"key"`
	Outcome  string `json:"outcome"`
	Duration int64  `json:"durationMs"`
	Message  string `json:"message,omitempty"`
}
type ReportInput struct {
	Key     string        `json:"key" jsonschema:"Unique batch key for replay protection"`
	Commit  string        `json:"commit"`
	Results []ResultInput `json:"results"`
}
type ReportOutput struct {
	Batch         int64 `json:"batch"`
	Sequence      int64 `json:"seq"`
	Inserted      int64 `json:"inserted"`
	NewTests      int64 `json:"newTests"`
	Failures      int64 `json:"failures"`
	Signatures    int64 `json:"signatures"`
	NewSignatures int64 `json:"newSignatures"`
	Questions     int64 `json:"questions"`
	Replay        bool  `json:"replay"`
}
type ListInput struct{ Folder, Cursor int64 }
type ListItem struct {
	ID, Ref, Folder, Rank, Head, Rev int64
	Title, Hash, State               string
	Tests                            int64
	Last                             []TestGlyph
}
type TestGlyph struct {
	Test    int64
	Outcome string
}
type ListOutput struct {
	Items []ListItem
	Open  int64
	Reads int
}
type SearchInput struct {
	Text string
	Area int64
}
type SearchItem struct {
	ID, Ref, Folder int64
	Title           string
	Relevance       float64
}
type SearchOutput struct{ Items []SearchItem }
type RecentInput struct{ Test int64 }
type RecentItem struct {
	ID, Test, Seq, Ord, Batch, Target int64
	Outcome, Basis                    string
	Case, Version                     *int64
	Duration                          *int64
	Signature                         *int64
	Message                           *string
}
type RecentOutput struct{ Items []RecentItem }
type GateInput struct{ Commit string }
type GateOutput struct {
	ID          int64           `json:"id"`
	Commit      string          `json:"commit"`
	Verdict     string          `json:"verdict"`
	Tally       json.RawMessage `json:"tally"`
	Outstanding int64           `json:"outstanding"`
	Expiry      *int64          `json:"expiry"`
	Rev         int64           `json:"rev"`
}
type QueueInput struct{ Owner int64 }
type QueueItem struct {
	ID, Ref, Owner, Rank                     int64
	Kind, Fingerprint, State, Evidence, Hash string
}
type QueueOutput struct {
	Items []QueueItem
	Open  int64
}
