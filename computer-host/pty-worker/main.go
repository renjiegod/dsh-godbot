// godbot-pty serves one locally selected user shell. Inherited pipes carry
// terminal bytes, acknowledgements and resize/input requests to its coordinator.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type command struct {
	Cmd  string `json:"cmd"`
	ID   int    `json:"id"`
	Data string `json:"data"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func window(cols, rows int) (*pty.Winsize, error) {
	if cols < 1 || cols > 512 || rows < 1 || rows > 256 {
		return nil, errors.New("invalid terminal size")
	}
	return &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}, nil
}

func killGroup(id int, sig syscall.Signal) {
	if id > 1 && id != syscall.Getpgrp() {
		_ = syscall.Kill(-id, sig)
	}
}

func run() error {
	if len(os.Args) != 4 {
		return errors.New("expected shell, columns and rows")
	}
	shell := os.Args[1]
	cols, err := strconv.Atoi(os.Args[2])
	if err != nil {
		return err
	}
	rows, err := strconv.Atoi(os.Args[3])
	if err != nil {
		return err
	}
	size, err := window(cols, rows)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(shell) {
		return errors.New("invalid login shell")
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGHUP, os.Interrupt)
	defer signal.Stop(sigs)
	cmd := exec.Command(shell, "-i")
	cmd.Args[0] = "-" + filepath.Base(shell)
	cmd.Dir = os.Getenv("HOME")
	master, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return err
	}
	defer master.Close()
	meta := os.NewFile(3, "coordinator status")
	if meta == nil {
		return errors.New("missing coordinator descriptor")
	}
	defer meta.Close()
	status := json.NewEncoder(meta)
	finish := make(chan error, 1)
	go func() { finish <- cmd.Wait() }()
	stopped := make(chan struct{})
	go func() { defer close(stopped); _, _ = io.Copy(os.Stdout, master) }()
	eof := make(chan struct{})
	input := make(chan command, 16)
	go func() {
		defer close(eof)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 65536), 131072)
		for scanner.Scan() {
			var c command
			if json.Unmarshal(scanner.Bytes(), &c) != nil || c.Cmd == "close" {
				return
			}
			input <- c
		}
	}()
	abort := make(chan error, 1)
	go func() {
		for c := range input {
			switch c.Cmd {
			case "write":
				data, err := base64.StdEncoding.DecodeString(c.Data)
				if err != nil || len(data) > 32768 {
					abort <- errors.New("invalid terminal bytes")
					return
				}
				if _, err = master.Write(data); err != nil {
					abort <- err
					return
				}
			case "resize":
				ws, err := window(c.Cols, c.Rows)
				if err != nil {
					abort <- err
					return
				}
				if err = pty.Setsize(master, ws); err != nil {
					abort <- err
					return
				}
			default:
				abort <- errors.New("invalid terminal request")
				return
			}
			if err := status.Encode(map[string]int{"ack": c.ID}); err != nil {
				abort <- err
				return
			}
		}
	}()
	// The shell's controlling TTY assigns a separate job-control group to a
	// foreground pipeline. Hang up both groups on owner loss, with a deadline.
	shutdown := func() {
		fg, _ := unix.IoctlGetInt(int(master.Fd()), unix.TIOCGPGRP)
		killGroup(fg, syscall.SIGHUP)
		killGroup(cmd.Process.Pid, syscall.SIGHUP)
		_ = master.Close()
		time.Sleep(120 * time.Millisecond)
		killGroup(fg, syscall.SIGKILL)
		killGroup(cmd.Process.Pid, syscall.SIGKILL)
		select {
		case <-finish:
		case <-time.After(time.Second):
		}
	}
	if err := status.Encode(map[string]bool{"ready": true}); err != nil {
		shutdown()
		return err
	}
	select {
	case <-finish:
		// Preserve final output before publishing the exit code.
		select {
		case <-stopped:
		case <-time.After(200 * time.Millisecond):
		}
		code := cmd.ProcessState.ExitCode()
		if code < 0 {
			if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				code = 128 + int(ws.Signal())
			}
		}
		return status.Encode(map[string]int{"exit": code})
	case <-eof:
		shutdown()
	case <-sigs:
		shutdown()
	case e := <-abort:
		shutdown()
		return e
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Could not run local terminal worker")
		os.Exit(1)
	}
}
