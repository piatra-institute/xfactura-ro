// Runs ANAF's DUKIntegrator for many files in one JVM: a file costs milliseconds instead of a JVM
// start plus the second that DUKIntegrator's shutdown hook waits before halting. Started by anaf.ts
// with the kit's DUKIntegrator.jar on the class path and the kit as the working directory:
//   java -Djava.awt.headless=true -cp DUKIntegrator.jar DukServer.java
// Each line on stdin is one DUKIntegrator command line, its arguments separated by tabs (for
// example `-v`, `D300`, the XML and the result file). It runs through DUKIntegrator's own
// `general.Main.main`, as the CLI runs it, and is answered on stdout once that returns: `done`,
// or `failed` with the error that escaped from it (anaf.ts then runs it again in a fresh JVM).
// `general.Main` keeps the command line in static fields, restored to their initial values before
// every command. The declaration validators DUKIntegrator caches stay loaded between commands, so
// anaf.ts sends here only the declarations shown to give the CLI's verdicts. The JVM halts when
// stdin closes, without running the shutdown hook each command registered.
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

public class DukServer {
  public static void main(String[] args) throws Exception {
    PrintStream answers =
        new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    // The validators and DUKIntegrator print their progress; only the answers go to stdout.
    PrintStream discard = new PrintStream(OutputStream.nullOutputStream());
    System.setOut(discard);
    System.setErr(discard);

    Class<?> dukMain = Class.forName("general.Main");
    Method run = dukMain.getMethod("main", String[].class);
    Map<Field, Object> initial = new LinkedHashMap<>();
    for (Field field : dukMain.getDeclaredFields()) {
      int modifiers = field.getModifiers();
      if (Modifier.isStatic(modifiers) && !Modifier.isFinal(modifiers)) {
        field.setAccessible(true);
        initial.put(field, field.get(null));
      }
    }

    BufferedReader commands =
        new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line; (line = commands.readLine()) != null; ) {
      String answer = "done";
      boolean fatal = false;
      try {
        for (Map.Entry<Field, Object> entry : initial.entrySet())
          entry.getKey().set(null, entry.getValue());
        run.invoke(null, (Object) line.split("\t", -1));
      } catch (InvocationTargetException error) {
        // An error main does not catch: anaf.ts runs the command again in a fresh JVM.
        answer = "failed " + error.getCause();
        fatal = error.getCause() instanceof VirtualMachineError;
      }
      answers.println(answer.replace('\n', ' '));
      // A JVM out of memory or stack is not reused: anaf.ts starts another one for the next file.
      if (fatal) break;
    }
    Runtime.getRuntime().halt(0);
  }
}
