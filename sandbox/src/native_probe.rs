//! Minimal integration probes. This module is compiled into the helper so
//! kernel tests need no C code, debugger, or additional native toolchain.

#![forbid(unsafe_code)]

use std::io::{self, Read};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::process::ExitCode;
use std::thread;

use nix::errno::Errno;
use nix::sys::ptrace;
use nix::sys::signal::Signal;
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::Pid;

fn address(name: &str) -> io::Result<SocketAddr> {
	// UnixListener/Stream's abstract namespace support encodes sun_path[0]
	// as NUL followed by the name, rather than creating a pathname socket.
	SocketAddr::from_abstract_name(name.as_bytes())
}

fn attach(pid: i32) -> Result<(), String> {
	let pid = Pid::from_raw(pid);
	// Attach is deliberately separate: only its errno may be classified as
	// an outside-jail denial. A later wait/detach failure is a broken probe.
	ptrace::attach(pid).map_err(|errno| format!("ATTACH:{errno}"))?;
	match waitpid(pid, Some(WaitPidFlag::WSTOPPED)) {
		Ok(WaitStatus::Stopped(_, Signal::SIGSTOP)) => {}
		Ok(status) => return Err(format!("WAIT:unexpected status {status:?}")),
		Err(errno) => return Err(format!("WAIT:{errno}")),
	}
	ptrace::detach(pid, None).map_err(|errno| format!("DETACH:{errno}"))?;
	println!("PTRACE_ATTACH_OK");
	Ok(())
}

fn connect(name: &str) -> Result<(), String> {
	let address = address(name).map_err(|error| format!("ADDRESS:{error}"))?;
	UnixStream::connect_addr(&address)
		.map_err(|error| format!("CONNECT_ABSTRACT:{}", Errno::from_raw(error.raw_os_error().unwrap_or(0))))?;
	println!("ABSTRACT_CONNECT_OK");
	Ok(())
}

fn listen(name: &str) -> Result<(), String> {
	let address = address(name).map_err(|error| format!("ADDRESS:{error}"))?;
	let _listener = UnixListener::bind_addr(&address)
		.map_err(|error| format!("BIND_ABSTRACT:{}", Errno::from_raw(error.raw_os_error().unwrap_or(0))))?;
	println!("ABSTRACT_LISTEN_OK:{}", std::process::id());
	use std::io::Write;
	io::stdout().flush().map_err(|error| format!("FLUSH:{error}"))?;
	loop {
		thread::park();
	}
}

fn environ(pid: i32) -> Result<(), String> {
	let mut file = std::fs::File::open(format!("/proc/{pid}/environ"))
		.map_err(|error| format!("OPEN_ENVIRON:{}", Errno::from_raw(error.raw_os_error().unwrap_or(0))))?;
	let mut byte = [0_u8; 1];
	file.read(&mut byte)
		.map_err(|error| format!("READ_ENVIRON:{}", Errno::from_raw(error.raw_os_error().unwrap_or(0))))?;
	println!("ENVIRON_READ_OK");
	Ok(())
}

fn mem(pid: i32) -> Result<(), String> {
	// Open is the correct mem control: /proc/<pid>/mem has no readable
	// stream at offset zero. Do not weaken environ to this open-only shape.
	std::fs::File::open(format!("/proc/{pid}/mem"))
		.map_err(|error| format!("OPEN_MEM:{}", Errno::from_raw(error.raw_os_error().unwrap_or(0))))?;
	println!("MEM_OPEN_OK");
	Ok(())
}

pub fn dispatch(args: &[String]) -> Result<ExitCode, String> {
	if args == ["identity"] {
		println!("IDENTITY_OK:{}:{}", nix::unistd::getuid(), nix::unistd::getgid());
		return Ok(ExitCode::SUCCESS);
	}
	if args == ["service-sleep"] {
		println!("SERVICE_READY:{}", std::process::id());
		use std::io::Write;
		io::stdout().flush().map_err(|error| format!("FLUSH:{error}"))?;
		loop {
			thread::park();
		}
	}
	if args == ["fds"] {
		let mut inherited = 0;
		for fd in 3..32 {
			let path = format!("/proc/self/fd/{fd}");
			if std::fs::read_link(path).is_ok() {
				inherited += 1;
			}
		}
		println!("INHERITED_FDS:{inherited}");
		return if inherited == 0 { Ok(ExitCode::SUCCESS) } else { Err(format!("inherited {inherited} descriptors")) };
	}
	let [operation, target] = args else {
		return Err("probe requires ptrace|abstract-connect|abstract-listen|read-environ|mem-open and one target, or identity".to_owned());
	};
	let result = match operation.as_str() {
		"ptrace" => target
			.parse::<i32>()
			.map_err(|error| format!("invalid pid: {error}"))
			.and_then(attach),
		"abstract-connect" => connect(target),
		"abstract-listen" => listen(target),
		"read-environ" => target
			.parse::<i32>()
			.map_err(|error| format!("invalid pid: {error}"))
			.and_then(environ),
		"mem-open" => target
			.parse::<i32>()
			.map_err(|error| format!("invalid pid: {error}"))
			.and_then(mem),
		"identity" => Err("identity takes no target".to_owned()),
		_ => Err(format!("unknown probe operation {operation}")),
	};
	result.map(|()| ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn abstract_address_is_not_a_pathname() {
		let address = address("sigrun-test-abstract").unwrap();
		assert_eq!(address.as_abstract_name(), Some(b"sigrun-test-abstract".as_slice()));
		assert!(address.as_pathname().is_none());
	}

	#[test]
	fn abstract_listener_accepts_an_outside_connection() {
		let name = format!("sigrun-probe-test-{}", std::process::id());
		let listener = UnixListener::bind_addr(&address(&name).unwrap()).unwrap();
		let stream = UnixStream::connect_addr(&address(&name).unwrap()).unwrap();
		drop(stream);
		drop(listener);
	}

	#[test]
	fn ptrace_attach_phase_is_distinct_from_later_failures() {
		// A nonexistent pid fails in ATTACH, not WAIT or DETACH.
		let error = attach(2_000_000_000).unwrap_err();
		assert!(error.starts_with("ATTACH:"), "{error}");
	}
}
