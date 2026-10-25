// Teire's Go helper (plan S05, research context/09-build-research/generic/go.md).
//
// One process per call, JSON on stdout. It type-checks and compares packages; it never runs their
// code. The caller sets the safe mode (GOTOOLCHAIN=local, CGO_ENABLED=0, GOENV=off, GOWORK=off, a
// scratch HOME and module cache, no credentials).
//
//	apidiff -old <module>@<version> -new <module>@<version> -work <dir>
//	    API changes between two versions of a module (or two majors: two module paths), from
//	    golang.org/x/exp/apidiff, as [{"message":…,"compatible":…}].
//	locate -dir <module dir> -targets <module>[,<module>…]
//	    Every use of a target module's objects in the module's packages (tests included), named the
//	    way apidiff names them: Name, Type.Field, Type.Method, (*Type).Method, ./sub.Name.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"go/constant"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/exp/apidiff"
	"golang.org/x/tools/go/packages"
)

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("usage: teire-go apidiff|locate …"))
	}
	var err error
	switch os.Args[1] {
	case "apidiff":
		err = runAPIDiff(os.Args[2:])
	case "locate":
		err = runLocate(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
	os.Exit(1)
}

func goCmd(dir string, args ...string) error {
	cmd := exec.Command("go", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("go %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func split(spec string) (string, string, error) {
	i := strings.LastIndex(spec, "@")
	if i <= 0 {
		return "", "", fmt.Errorf("want module@version, got %q", spec)
	}
	return spec[:i], spec[i+1:], nil
}

// loadModule fetches path@version into a scratch module and returns its packages' types.
func loadModule(dir, path, version string) (*apidiff.Module, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := goCmd(dir, "mod", "init", "teire.local/diff"); err != nil {
		return nil, err
	}
	// `path/...@version`: every package's dependencies must be in the build list (research: plain
	// `path@version` fails with `invalid package name`).
	if err := goCmd(dir, "get", path+"/...@"+version); err != nil {
		return nil, err
	}
	cfg := &packages.Config{Dir: dir, Mode: packages.NeedName | packages.NeedTypes | packages.NeedImports}
	pkgs, err := packages.Load(cfg, path+"/...")
	if err != nil {
		return nil, err
	}
	m := &apidiff.Module{Path: path}
	for _, p := range pkgs {
		if p.Types == nil || strings.Contains(p.PkgPath, "/internal/") || strings.HasSuffix(p.PkgPath, "/internal") {
			continue
		}
		if len(p.Errors) > 0 && p.Types.Scope().Len() == 0 {
			continue
		}
		m.Packages = append(m.Packages, p.Types)
	}
	if len(m.Packages) == 0 {
		return nil, fmt.Errorf("no packages loaded for %s@%s", path, version)
	}
	return m, nil
}

func runAPIDiff(args []string) error {
	fs := flag.NewFlagSet("apidiff", flag.ContinueOnError)
	oldSpec := fs.String("old", "", "module@version")
	newSpec := fs.String("new", "", "module@version")
	work := fs.String("work", "", "scratch directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	oldPath, oldVersion, err := split(*oldSpec)
	if err != nil {
		return err
	}
	newPath, newVersion, err := split(*newSpec)
	if err != nil {
		return err
	}
	oldMod, err := loadModule(filepath.Join(*work, "old"), oldPath, oldVersion)
	if err != nil {
		return err
	}
	newMod, err := loadModule(filepath.Join(*work, "new"), newPath, newVersion)
	if err != nil {
		return err
	}
	report := apidiff.ModuleChanges(oldMod, newMod)
	type change struct {
		Message    string `json:"message"`
		Compatible bool   `json:"compatible"`
	}
	out := []change{}
	for _, c := range report.Changes {
		out = append(out, change{Message: c.Message, Compatible: c.Compatible})
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"old":      map[string]any{"path": oldPath, "version": oldVersion, "packages": len(oldMod.Packages)},
		"new":      map[string]any{"path": newPath, "version": newVersion, "packages": len(newMod.Packages)},
		"changes":  out,
		"toolchain": strings.TrimPrefix(goVersion(), "go version "),
	})
}

func goVersion() string {
	out, err := exec.Command("go", "version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

type use struct {
	File       string `json:"file"`
	Line       int    `json:"line"`
	Col        int    `json:"col"`
	Module     string `json:"module"`
	Pkg        string `json:"pkg"`
	Symbol     string `json:"symbol"`
	Kind       string `json:"kind"`
	ConstValue string `json:"constValue,omitempty"`
}

// owner finds the named struct type in the object's package that declares field v.
func owner(v *types.Var) string {
	scope := v.Pkg().Scope()
	for _, name := range scope.Names() {
		tn, ok := scope.Lookup(name).(*types.TypeName)
		if !ok {
			continue
		}
		st, ok := tn.Type().Underlying().(*types.Struct)
		if !ok {
			continue
		}
		for i := 0; i < st.NumFields(); i++ {
			if st.Field(i) == v {
				return name
			}
		}
	}
	return ""
}

// symbolName renders an object the way apidiff names it, relative to its module.
func symbolName(obj types.Object, module string) (string, string) {
	prefix := ""
	if p := obj.Pkg().Path(); p != module {
		prefix = "./" + strings.TrimPrefix(p, module+"/") + "."
	}
	switch o := obj.(type) {
	case *types.Func:
		sig, _ := o.Type().(*types.Signature)
		if sig != nil && sig.Recv() != nil {
			recv := sig.Recv().Type()
			ptr := false
			if p, ok := recv.(*types.Pointer); ok {
				recv, ptr = p.Elem(), true
			}
			name := recv.String()
			if n, ok := recv.(*types.Named); ok {
				name = n.Obj().Name()
			}
			if ptr {
				return prefix + "(*" + name + ")." + o.Name(), "method"
			}
			return prefix + name + "." + o.Name(), "method"
		}
		return prefix + o.Name(), "func"
	case *types.Var:
		if o.IsField() {
			if t := owner(o); t != "" {
				return prefix + t + "." + o.Name(), "field"
			}
			return "", ""
		}
		return prefix + o.Name(), "var"
	case *types.Const:
		return prefix + o.Name(), "const"
	case *types.TypeName:
		return prefix + o.Name(), "type"
	}
	return "", ""
}

func runLocate(args []string) error {
	fs := flag.NewFlagSet("locate", flag.ContinueOnError)
	dir := fs.String("dir", ".", "module directory")
	targets := fs.String("targets", "", "comma-separated module paths")
	modfile := fs.String("modfile", "", "go.mod to read instead of the module's own (a scratch copy)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	mods := strings.Split(*targets, ",")
	sort.Slice(mods, func(i, j int) bool { return len(mods[i]) > len(mods[j]) })
	cfg := &packages.Config{
		Dir:   *dir,
		Mode:  packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo,
		Tests: true,
	}
	if *modfile != "" {
		cfg.BuildFlags = []string{"-modfile=" + *modfile}
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return err
	}
	abs, _ := filepath.Abs(*dir)
	seen := map[string]bool{}
	out := []use{}
	errs := []string{}
	for _, p := range pkgs {
		for _, e := range p.Errors {
			errs = append(errs, e.Msg)
		}
		if p.TypesInfo == nil {
			continue
		}
		for id, obj := range p.TypesInfo.Uses {
			if obj == nil || obj.Pkg() == nil {
				continue
			}
			module := ""
			for _, m := range mods {
				if m != "" && (obj.Pkg().Path() == m || strings.HasPrefix(obj.Pkg().Path(), m+"/")) {
					module = m
					break
				}
			}
			if module == "" {
				continue
			}
			name, kind := symbolName(obj, module)
			if name == "" {
				continue
			}
			pos := p.Fset.Position(id.Pos())
			rel, _ := filepath.Rel(abs, pos.Filename)
			key := fmt.Sprintf("%s:%d:%d:%s", rel, pos.Line, pos.Column, name)
			if seen[key] {
				continue
			}
			seen[key] = true
			u := use{File: filepath.ToSlash(rel), Line: pos.Line, Col: pos.Column, Module: module, Pkg: obj.Pkg().Path(), Symbol: name, Kind: kind}
			if c, ok := obj.(*types.Const); ok && c.Val().Kind() == constant.String {
				u.ConstValue = constant.StringVal(c.Val())
			}
			out = append(out, u)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].Col < out[j].Col
	})
	files := map[string]bool{}
	for _, p := range pkgs {
		for _, f := range p.GoFiles {
			files[f] = true
		}
	}
	if len(errs) > 20 {
		errs = errs[:20]
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"uses": out, "files": len(files), "errors": errs})
}
