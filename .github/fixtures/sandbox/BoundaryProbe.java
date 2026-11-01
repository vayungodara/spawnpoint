import java.net.*;
import java.nio.file.*;
import java.io.*;
import java.util.*;

// Only harness-created files and listeners are used. Never inspect real
// credentials or contact the panel. Values are not printed, only access results.
public class BoundaryProbe {
    interface Attempt { void run() throws Exception; }
    static void check(String name, Attempt attempt) {
        boolean allowed;
        try { attempt.run(); allowed = true; } catch (Exception e) { allowed = false; }
        System.out.println("ACCESS " + name + " " + (allowed ? "ALLOWED" : "DENIED"));
    }
    static void connect(int port, int expected) throws Exception {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 1500);
            socket.setSoTimeout(1500);
            if (socket.getInputStream().read() != expected) throw new Exception("unexpected listener");
        }
    }
    static ServerSocket listen(int port) throws Exception {
        ServerSocket server = new ServerSocket(port, 4, InetAddress.getByName("127.0.0.1"));
        Thread thread = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket client = server.accept()) { client.getOutputStream().write(91); }
                catch (Exception ignored) { }
            }
        });
        thread.setDaemon(true);
        thread.start();
        return server;
    }
    public static void main(String[] args) throws Exception {
        if (args[0].equals("spawn") || args[0].equals("hold")) {
            check("descendant", () -> {
                var command = new ArrayList<String>();
                if (Files.isExecutable(Path.of("/usr/bin/setsid"))) command.add("/usr/bin/setsid");
                command.add(ProcessHandle.current().info().command().orElseThrow());
                command.addAll(List.of("-Xmx128m", "-cp", ".", "BoundaryProbe", "descendant"));
                command.addAll(Arrays.asList(args).subList(1, args.length));
                Process child = new ProcessBuilder(command).redirectErrorStream(true).start();
                var output = new BufferedReader(new InputStreamReader(child.getInputStream()));
                for (String line; (line = output.readLine()) != null;) {
                    System.out.println(line);
                    if (line.equals("DESCENDANT READY")) return;
                }
                throw new Exception("descendant did not start");
            });
            if (args[0].equals("hold")) {
                System.out.println("HOLD READY");
                System.out.flush();
                Thread.sleep(60000);
            }
            return;
        }
        if (args[0].equals("listen")) {
            try (ServerSocket server = listen(Integer.parseInt(args[1]))) {
                System.out.println("READY");
                System.out.flush();
                Thread.sleep(60000);
            }
            return;
        }
        Path outside = Path.of(args[1]), panel = Path.of(args[2]), home = Path.of(args[3]), sibling = Path.of(args[4]);
        int hostPort = Integer.parseInt(args[5]), ownPort = Integer.parseInt(args[6]);
        ServerSocket own = !args[0].equals("pair") ? listen(ownPort) : null;
        check("outside-read", () -> Files.readAllBytes(outside));
        check("outside-alias-read", () -> Files.readAllBytes(Path.of(args[8])));
        check("outside-write", () -> Files.writeString(outside, "changed", StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING));
        check("panel-list", () -> { try (var files = Files.list(panel)) { files.count(); } });
        check("home-read", () -> Files.readAllBytes(home));
        check("sibling-read", () -> Files.readAllBytes(sibling));
        check("sibling-write", () -> Files.writeString(sibling, "changed", StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING));
        check("runtime-read", () -> Files.readAllBytes(Path.of(args[7])));
        check("runtime-write", () -> Files.writeString(Path.of(args[7]), "changed", StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING));
        check("host-port", () -> connect(hostPort, 42));
        check("environment", () -> {
            if (System.getenv("SPAWNPOINT_BOUNDARY_CANARY") == null) throw new Exception("absent");
        });
        if (System.getProperty("os.name").equals("Linux")) check("namespace-create", () -> {
            String bwrap = Files.isExecutable(Path.of("/usr/local/libexec/spawnpoint-bwrap"))
                ? "/usr/local/libexec/spawnpoint-bwrap" : "/usr/bin/bwrap";
            Process child = new ProcessBuilder(bwrap, "--ro-bind", "/", "/", "--unshare-user", "/usr/bin/true").start();
            if (child.waitFor() != 0) throw new Exception("namespace refused");
        });
        check("scratch-write", () -> {
            Files.writeString(Path.of("control.txt"), "scratch control");
            Files.createDirectories(Path.of("outputs", "nested"));
            Files.writeString(Path.of("outputs", "nested", "control.txt"), "nested control");
        });
        check("own-port", () -> connect(ownPort, 91));
        Files.createDirectories(Path.of("config"));
        // Creating a link in private scratch is harmless; following it must
        // not expose the target, and the panel must refuse it as an output.
        check("symlink-create", () -> Files.createSymbolicLink(Path.of("config", "link"), outside));
        check("symlink-read", () -> Files.readAllBytes(Path.of("config", "link")));
        check("runtime-hardlink-write", () -> {
            Path link = Files.createLink(Path.of("config", "runtime-link"), Path.of(args[7]));
            Files.writeString(link, "changed", StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
        });
        if (own != null) own.close();
        if (args[0].equals("descendant")) {
            System.out.println("DESCENDANT READY");
            System.out.flush();
            Thread.sleep(2000);
            Files.writeString(Path.of("late-write.txt"), "descendant survived");
        }
    }
}
