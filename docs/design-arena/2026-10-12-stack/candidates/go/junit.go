package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

func GenerateJUnit() []byte {
	var out bytes.Buffer
	out.WriteString(`<testsuite name="arena" tests="10000">`)
	for i := 0; i < 10000; i++ {
		fmt.Fprintf(&out, `<testcase classname="suite" name="test%d" time="0.012">`, i)
		if i < 200 {
			out.WriteString(`<failure message="assertion">`)
			_ = xml.EscapeText(&out, []byte(fmt.Sprintf("group %d %s", i%20, strings.Repeat("expected receipt to match observed value; ", 10))))
			out.WriteString(`</failure>`)
		}
		out.WriteString(`</testcase>`)
	}
	out.WriteString(`</testsuite>`)
	return out.Bytes()
}

func ParseJUnit(data []byte) ([]ResultInput, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	out := make([]ResultInput, 0, 10000)
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "testcase" {
			continue
		}
		var tc struct {
			Name    string `xml:"name,attr"`
			Class   string `xml:"classname,attr"`
			Time    string `xml:"time,attr"`
			Failure *struct {
				Body    string `xml:",chardata"`
				Message string `xml:"message,attr"`
			} `xml:"failure"`
			Error *struct {
				Body    string `xml:",chardata"`
				Message string `xml:"message,attr"`
			} `xml:"error"`
			Skipped *struct{} `xml:"skipped"`
		}
		if err = decoder.DecodeElement(&tc, &start); err != nil {
			return nil, err
		}
		duration, err := strconv.ParseFloat(tc.Time, 64)
		if err != nil {
			return nil, err
		}
		r := ResultInput{Key: tc.Class + "::" + tc.Name, Outcome: "pass", Duration: int64(duration * 1000)}
		if tc.Failure != nil {
			r.Outcome = "fail"
			r.Message = tc.Failure.Body
			if r.Message == "" {
				r.Message = tc.Failure.Message
			}
		}
		if tc.Error != nil {
			r.Outcome = "error"
			r.Message = tc.Error.Body
			if r.Message == "" {
				r.Message = tc.Error.Message
			}
		}
		if tc.Skipped != nil {
			r.Outcome = "skip"
		}
		out = append(out, r)
	}
}
