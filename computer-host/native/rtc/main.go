// The desktop media process speaks newline-delimited JSON over private inherited
// stdin/stdout. FD 3 receives a live, VP8-encoded IVF stream from the capture
// pipeline. No local TCP port or remote command endpoint is exposed.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type command struct {
	ID         int                     `json:"id"`
	Type       string                  `json:"type"`
	SDP        string                  `json:"sdp"`
	Candidate  webrtc.ICECandidateInit `json:"candidate"`
	ICEServers []webrtc.ICEServer      `json:"iceServers"`
}
type sender struct {
	mu  sync.Mutex
	out *json.Encoder
}

func (s *sender) send(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.out.Encode(v) != nil {
		os.Exit(0)
	}
}

// Capture drives frame timing. Dropping the first frames before ICE completes
// is fine: the encoder produces a fresh keyframe at least once each second.
func frames(in io.Reader, track *webrtc.TrackLocalStaticSample) error {
	var header [32]byte
	if _, err := io.ReadFull(in, header[:]); err != nil {
		return err
	}
	if string(header[:4]) != "DKIF" || string(header[8:12]) != "VP80" {
		return errors.New("expected VP8 IVF")
	}
	var frame [12]byte
	for {
		if _, err := io.ReadFull(in, frame[:]); err != nil {
			return err
		}
		n := binary.LittleEndian.Uint32(frame[:4])
		if n == 0 || n > 8<<20 {
			return errors.New("invalid frame size")
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(in, data); err != nil {
			return err
		}
		if err := track.WriteSample(media.Sample{Data: data, Duration: time.Second / 15}); err != nil {
			return err
		}
	}
}
func run() error {
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), 256<<10)
	if !scan.Scan() {
		return nil
	}
	var first command
	if err := json.Unmarshal(scan.Bytes(), &first); err != nil || first.Type != "start" {
		return errors.New("expected start")
	}
	out := &sender{out: json.NewEncoder(os.Stdout)}
	var settings webrtc.SettingEngine
	if configured := os.Getenv("GODBOT_DESKTOP_UDP_PORT"); configured != "" {
		port, err := strconv.Atoi(configured)
		if err != nil || port < 1024 || port > 65535 {
			return errors.New("invalid configured media UDP port")
		}
		udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: port})
		if err != nil {
			return err
		}
		mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: udp})
		defer mux.Close()
		settings.SetICEUDPMux(mux)
		if addresses := os.Getenv("GODBOT_DESKTOP_PUBLIC_IPS"); addresses != "" {
			ips := strings.Split(addresses, ",")
			for _, ip := range ips {
				if net.ParseIP(ip) == nil {
					return errors.New("invalid configured media IP")
				}
			}
			rule := webrtc.ICEAddressRewriteRule{External: ips, AsCandidateType: webrtc.ICECandidateTypeHost, Mode: webrtc.ICEAddressRewriteAppend}
			if err := settings.SetICEAddressRewriteRules(rule); err != nil {
				return err
			}
		}
	}
	config := webrtc.Configuration{ICEServers: first.ICEServers}
	if os.Getenv("GODBOT_DESKTOP_RELAY_ONLY") == "1" {
		config.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(config)
	if err != nil {
		return err
	}
	defer pc.Close()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "screen", "godbot-desktop")
	if err != nil {
		return err
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		return err
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			out.send(map[string]any{"type": "signal", "signal": map[string]any{"type": "candidate", "candidate": c.ToJSON()}})
		}
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed {
			out.send(map[string]any{"type": "ended", "reason": "Desktop media connection failed"})
		}
	})
	var dcMu sync.Mutex
	var activeDC *webrtc.DataChannel
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dcMu.Lock()
		if activeDC != nil || dc.Label() != "godbot-input-v1" || !dc.Ordered() || dc.MaxRetransmits() != nil || dc.MaxPacketLifeTime() != nil {
			dcMu.Unlock()
			_ = dc.Close()
			return
		}
		activeDC = dc
		dcMu.Unlock()
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			if m.IsString && len(m.Data) <= 8192 && json.Valid(m.Data) {
				out.send(map[string]any{"type": "input", "event": json.RawMessage(m.Data)})
			}
		})
		dc.OnClose(func() { out.send(map[string]string{"type": "release"}) })
	})
	go func() {
		input := os.NewFile(3, "capture")
		defer input.Close()
		if err := frames(input, track); err != nil {
			out.send(map[string]string{"type": "ended", "reason": "Desktop capture ended"})
		}
	}()
	out.send(map[string]string{"type": "ready"})
	for scan.Scan() {
		var c command
		if err := json.Unmarshal(scan.Bytes(), &c); err != nil {
			return err
		}
		var callErr error
		switch c.Type {
		case "offer":
			callErr = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: c.SDP})
			if callErr == nil {
				var answer webrtc.SessionDescription
				answer, callErr = pc.CreateAnswer(nil)
				if callErr == nil {
					callErr = pc.SetLocalDescription(answer)
				}
				if callErr == nil {
					out.send(map[string]any{"type": "signal", "signal": answer})
				}
			}
		case "candidate":
			callErr = pc.AddICECandidate(c.Candidate)
		case "close":
			return nil
		default:
			callErr = errors.New("unknown signal")
		}
		if callErr != nil {
			out.send(map[string]any{"id": c.ID, "error": "Invalid desktop signaling message"})
		} else {
			out.send(map[string]any{"id": c.ID, "ok": true})
		}
	}
	return scan.Err()
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Desktop media helper stopped:", err)
		os.Exit(1)
	}
}
