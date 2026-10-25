// Teire's bytecode reference scan (plan S08, research jvm.md Job 5): every call, field access,
// object creation, type check and supertype in the repo's compiled classes whose owner lies in one
// of the given packages, with the source file and line, exactly as javac/kotlinc resolved them
// (imports, overloads, aliases, inheritance). Reads class files with the JDK's ClassFile API; runs
// nothing. Usage: java TeireRefs.java com/google/common,okhttp3 DIR...
// Output, tab-separated: class, source file, line, kind, owner, member, descriptor.
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeModel;
import java.lang.classfile.MethodModel;
import java.lang.classfile.instruction.FieldInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.LineNumber;
import java.lang.classfile.instruction.NewObjectInstruction;
import java.lang.classfile.instruction.TypeCheckInstruction;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

public class TeireRefs {
  static List<String> prefixes;

  public static void main(String[] args) throws Exception {
    prefixes = Arrays.asList(args[0].split(","));
    for (int i = 1; i < args.length; i++) {
      Path root = Path.of(args[i]);
      if (!Files.isDirectory(root)) continue;
      try (var paths = Files.walk(root)) {
        for (Path p : (Iterable<Path>) paths.filter(x -> x.toString().endsWith(".class"))::iterator) {
          try {
            scan(ClassFile.of().parse(Files.readAllBytes(p)));
          } catch (RuntimeException e) {
            System.err.println("teire-refs: skipped " + p + ": " + e.getMessage());
          }
        }
      }
    }
  }

  static boolean wanted(String owner) {
    for (String p : prefixes) if (owner.equals(p) || owner.startsWith(p + "/")) return true;
    return false;
  }

  static void emit(String cls, String src, int line, String kind, String owner, String member, String desc) {
    if (wanted(owner)) System.out.println(String.join("\t", cls, src, Integer.toString(line), kind, owner, member, desc));
  }

  static void scan(ClassModel cm) {
    String cls = cm.thisClass().asInternalName();
    String src = cm.findAttribute(Attributes.sourceFile()).map(a -> a.sourceFile().stringValue()).orElse("");
    cm.superclass().ifPresent(s -> emit(cls, src, 0, "extends", s.asInternalName(), "", ""));
    cm.interfaces().forEach(i -> emit(cls, src, 0, "extends", i.asInternalName(), "", ""));
    for (MethodModel m : cm.methods()) {
      var code = m.code();
      if (code.isEmpty()) continue;
      int line = 0;
      for (CodeElement e : (CodeModel) code.get()) {
        if (e instanceof LineNumber ln) line = ln.line();
        else if (e instanceof InvokeInstruction inv)
          emit(cls, src, line, "call", inv.owner().asInternalName(), inv.name().stringValue(), inv.type().stringValue());
        else if (e instanceof FieldInstruction f)
          emit(cls, src, line, "field", f.owner().asInternalName(), f.name().stringValue(), f.type().stringValue());
        else if (e instanceof NewObjectInstruction n)
          emit(cls, src, line, "new", n.className().asInternalName(), "<init>", "");
        else if (e instanceof TypeCheckInstruction t)
          emit(cls, src, line, "type", t.type().asInternalName(), "", "");
      }
    }
  }
}
