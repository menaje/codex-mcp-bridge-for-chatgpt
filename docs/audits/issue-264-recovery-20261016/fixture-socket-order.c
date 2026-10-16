// clang fixture-socket-order.c -o /tmp/fixture-socket-order && /tmp/fixture-socket-order
// This diagnostic executable counts SIGPIPE; the application does not install this handler.
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

static volatile sig_atomic_t received;
static void on_pipe(int signal_number) { (void)signal_number; received++; }

int main(void) {
    signal(SIGPIPE, on_pipe);
    for (int late = 0; late < 2; late++) {
        int descriptors[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, descriptors) != 0) return 1;
        int one = 1, option = 0;
        socklen_t length = sizeof(option);
        if (late) shutdown(descriptors[0], SHUT_RDWR);
        errno = 0;
        int result = setsockopt(descriptors[0], SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
        int option_error = errno;
        if (!late) shutdown(descriptors[0], SHUT_RDWR);
        getsockopt(descriptors[0], SOL_SOCKET, SO_NOSIGPIPE, &option, &length);
        int before = received;
        ssize_t count = write(descriptors[0], "x", 1);
        int write_error = errno;
        printf("option_after_shutdown=%d setsockopt=%d errno=%d option=%d "
               "write=%ld write_errno=%d signals=%d\n", late, result, option_error,
               option, count, write_error, received - before);
        close(descriptors[0]);
        close(descriptors[1]);
    }
}
