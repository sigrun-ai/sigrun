/* Native probes for the kernel suite; no third-party debugger is required. */
// _GNU_SOURCE is the documented glibc feature macro for abstract sockets.
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int fail(const char *operation) {
	printf("PROBE_ERRNO:%s:%d\n", operation, errno);
	return 70;
}

int main(int argc, char **argv) {
	if (argc < 3) return 64;
	if (strcmp(argv[1], "ptrace") == 0) {
		pid_t pid = (pid_t)strtol(argv[2], NULL, 10);
		if (ptrace(PTRACE_ATTACH, pid, NULL, NULL) != 0) return fail("PTRACE_ATTACH");
		if (waitpid(pid, NULL, 0) < 0) return fail("WAITPID");
		if (ptrace(PTRACE_DETACH, pid, NULL, NULL) != 0) return fail("PTRACE_DETACH");
		puts("PTRACE_ATTACH_OK");
		return 0;
	}
	if (strcmp(argv[1], "socket") == 0) {
		struct sockaddr_un address = { .sun_family = AF_UNIX };
		if (strlen(argv[2]) >= sizeof(address.sun_path)) return 64;
		strcpy(address.sun_path, argv[2]);
		int fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if (fd < 0) return fail("SOCKET");
		if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
			int savedError = errno;
			close(fd);
			errno = savedError;
			return fail("CONNECT_ABSTRACT");
		}
		close(fd);
		puts("ABSTRACT_CONNECT_OK");
		return 0;
	}
	if (strcmp(argv[1], "socket-server") == 0) {
		struct sockaddr_un address = { .sun_family = AF_UNIX };
		strcpy(address.sun_path, argv[2]);
		int fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if (fd < 0) return fail("SOCKET");
		if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) return fail("BIND_ABSTRACT");
		if (listen(fd, 4) != 0) return fail("LISTEN_ABSTRACT");
		printf("ABSTRACT_LISTEN_OK:%d\n", getpid());
		fflush(stdout);
		for (;;) pause();
	}
	if (strcmp(argv[1], "read-environ") == 0) {
		char path[128];
		snprintf(path, sizeof(path), "/proc/%ld/environ", strtol(argv[2], NULL, 10));
		int fd = open(path, O_RDONLY);
		if (fd < 0) return fail("OPEN_ENVIRON");
		char buffer[1];
		if (read(fd, buffer, sizeof(buffer)) < 0) return fail("READ_ENVIRON");
		close(fd);
		puts("ENVIRON_READ_OK");
		return 0;
	}
	if (strcmp(argv[1], "mem-open") == 0) {
		char path[128];
		snprintf(path, sizeof(path), "/proc/%ld/mem", strtol(argv[2], NULL, 10));
		int fd = open(path, O_RDONLY);
		if (fd < 0) return fail("OPEN_MEM");
		close(fd);
		puts("MEM_OPEN_OK");
		return 0;
	}
	if (strcmp(argv[1], "identity") == 0) {
		printf("IDENTITY_OK:%d:%d\n", getuid(), getgid());
		return 0;
	}
	if (strcmp(argv[1], "fds") == 0) {
		int inherited = 0;
		for (int fd = 3; fd < 32; fd++) {
			if (fcntl(fd, F_GETFD) != -1) inherited++;
		}
		printf("INHERITED_FDS:%d\n", inherited);
		return inherited == 0 ? 0 : 71;
	}
	if (strcmp(argv[1], "kill") == 0) {
		pid_t pid = (pid_t)strtol(argv[2], NULL, 10);
		if (kill(pid, SIGTERM) != 0) return fail("KILL");
		puts("KILL_OK");
		return 0;
	}
	if (strcmp(argv[1], "sleep") == 0) {
		printf("SERVICE_READY:%d\n", getpid());
		fflush(stdout);
		for (;;) pause();
	}
	return 64;
}
