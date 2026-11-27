package i18n

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/veypi/vigo/flags"
)

// newAddCmd 构造一个只带位置参数的 add 子命令（未解析）。
func newAddCmd(args ...string) *flags.Flags {
	f := flags.New("add", "test")
	f.AllowArgs()
	f.Command = func() error { return nil }
	if err := f.ParseArgs(args); err != nil {
		panic(err)
	}
	return f
}

func TestReadAddInputPrefersJSONFlagOverStdin(t *testing.T) {
	// stdin 是空管道时，-json 参数仍必须生效（CI / 重定向场景）。
	old := addOpts.JSON
	defer func() { addOpts.JSON = old }()

	addOpts.JSON = `{"zh-CN":{"k":"v"}}`
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()

	input, err := readAddInput(newAddCmd(), r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := input["zh-CN"]["k"]; got != "v" {
		t.Errorf("zh-CN.k = %v, want v", got)
	}
}

func TestReadAddInputPositionalArgs(t *testing.T) {
	old := addOpts.JSON
	defer func() { addOpts.JSON = old }()
	addOpts.JSON = ""

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()

	cmd := newAddCmd(`{"zh-CN":{"k2":"v2"}}`)
	input, err := readAddInput(cmd, r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := input["zh-CN"]["k2"]; got != "v2" {
		t.Errorf("zh-CN.k2 = %v, want v2", got)
	}
}

func TestReadAddInputFromStdinPipe(t *testing.T) {
	old := addOpts.JSON
	defer func() { addOpts.JSON = old }()
	addOpts.JSON = ""

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	go func() {
		w.WriteString(`{"zh-CN":{"k3":"v3"}}`)
		w.Close()
	}()

	input, err := readAddInput(newAddCmd(), r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := input["zh-CN"]["k3"]; got != "v3" {
		t.Errorf("zh-CN.k3 = %v, want v3", got)
	}
}

func TestReadAddInputEmptyStdinIsNoInput(t *testing.T) {
	old := addOpts.JSON
	defer func() { addOpts.JSON = old }()
	addOpts.JSON = ""

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	w.Close()

	if _, err := readAddInput(newAddCmd(), r); err != errNoAddInput {
		t.Errorf("err = %v, want errNoAddInput", err)
	}
}

func TestReadAddInputInvalidJSON(t *testing.T) {
	old := addOpts.JSON
	defer func() { addOpts.JSON = old }()
	addOpts.JSON = "{not json"

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()

	if _, err := readAddInput(newAddCmd(), r); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

// TestScanStatsCountsPluralObjects 复数形式（{one, other}）也属于已翻译，
// 覆盖率统计不能只认字符串值。
func TestScanStatsCountsPluralObjects(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "langs.json")

	cfg := &runtimeConfig{
		Output:          out,
		Languages:       []string{"zh-CN", "en-US"},
		DefaultLanguage: "zh-CN",
	}
	translations := map[string]map[string]interface{}{
		"zh-CN": {"k": "值", "p": "值"},
		"en-US": {"k": "value", "p": map[string]interface{}{"one": "one", "other": "others"}},
	}
	if err := SaveTranslations(out, translations, cfg.Format, cfg.DefaultLanguage); err != nil {
		t.Fatal(err)
	}

	loaded, err := LoadTranslations(out)
	if err != nil {
		t.Fatal(err)
	}

	found := map[string]bool{"k": true, "p": true}
	for _, lang := range cfg.Languages {
		items := loaded[lang]
		done := 0
		for key := range found {
			if value, exists := items[key]; exists && !isEmptyValue(value) {
				done++
			}
		}
		if done != 2 {
			t.Errorf("%s: done = %d, want 2", lang, done)
		}
	}
}
