//! 认证模块单元测试：功能、异常、安全。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use harness_auth::{
    AuthConfig, AuthError, AuthService, FileStore, MemoryStore, UserRole, UserStore,
};

/// 注入一个可控时钟的 AuthService。
fn clocked(cfg: AuthConfig) -> (AuthService, Arc<AtomicU64>) {
    let clock = Arc::new(AtomicU64::new(1_000_000_000));
    let clk = clock.clone();
    let svc = AuthService::with_clock(
        Arc::new(MemoryStore::new()),
        cfg,
        Arc::new(move || clk.load(Ordering::SeqCst)),
    );
    (svc, clock)
}

fn default_cfg() -> AuthConfig {
    AuthConfig {
        session_ttl_ms: 60_000,
        max_failed_attempts: 3,
        lockout_ms: 30_000,
    }
}

#[test]
fn register_login_validate_logout() {
    let (svc, _) = clocked(default_cfg());
    svc.register("alice", "Passw0rd12", "Alice", UserRole::Admin).unwrap();
    // 重复注册
    assert_eq!(
        svc.register("alice", "Passw0rd12", "A", UserRole::User).unwrap_err(),
        AuthError::UsernameTaken
    );

    let sess = svc.login("alice", "Passw0rd12").unwrap();
    assert_eq!(sess.username, "alice");
    assert_eq!(sess.role, UserRole::Admin);

    let user = svc.validate_session(&sess.raw_token).unwrap();
    assert_eq!(user.display_name, "Alice");

    svc.logout(&sess.raw_token).unwrap();
    assert_eq!(svc.validate_session(&sess.raw_token).unwrap_err(), AuthError::InvalidToken);
}

#[test]
fn wrong_password_and_user_not_found_are_indistinguishable() {
    let (svc, _) = clocked(default_cfg());
    svc.register("bob", "Passw0rd12", "Bob", UserRole::User).unwrap();
    let wrong = svc.login("bob", "wrongpass1").unwrap_err();
    let missing = svc.login("ghost", "wrongpass1").unwrap_err();
    // 避免枚举：错误密码与账号不存在返回一致错误。
    assert_eq!(wrong, AuthError::InvalidCredentials);
    assert_eq!(missing, AuthError::InvalidCredentials);
}

#[test]
fn login_lockout_after_max_attempts() {
    let (svc, clock) = clocked(default_cfg());
    svc.register("carol", "Passw0rd12", "Carol", UserRole::User).unwrap();
    for _ in 0..3 {
        assert_eq!(svc.login("carol", "badpass12").unwrap_err(), AuthError::InvalidCredentials);
    }
    // 第 4 次应触发锁定
    match svc.login("carol", "Passw0rd12").unwrap_err() {
        AuthError::RateLimited { retry_after_secs } => assert!(retry_after_secs > 0),
        e => panic!("expected RateLimited, got {e:?}"),
    }
    // 时间未过仍锁定：即使密码正确也被拒（限流优先于密码校验）。
    clock.fetch_add(10_000, Ordering::SeqCst);
    assert!(matches!(svc.login("carol", "Passw0rd12").unwrap_err(), AuthError::RateLimited { .. }));
    // 超过锁定时间后可正常登录。
    clock.fetch_add(30_000, Ordering::SeqCst);
    svc.login("carol", "Passw0rd12").unwrap();
}

#[test]
fn session_expires() {
    let (svc, clock) = clocked(default_cfg());
    svc.register("dave", "Passw0rd12", "Dave", UserRole::Viewer).unwrap();
    let sess = svc.login("dave", "Passw0rd12").unwrap();
    clock.fetch_add(60_001, Ordering::SeqCst);
    assert_eq!(svc.validate_session(&sess.raw_token).unwrap_err(), AuthError::SessionExpired);
    // 过期后被吊销
    assert_eq!(svc.validate_session(&sess.raw_token).unwrap_err(), AuthError::InvalidToken);
}

#[test]
fn change_password_revokes_all_sessions() {
    let (svc, _) = clocked(default_cfg());
    svc.register("erin", "Passw0rd12", "Erin", UserRole::User).unwrap();
    let s1 = svc.login("erin", "Passw0rd12").unwrap();
    let s2 = svc.login("erin", "Passw0rd12").unwrap();
    svc.change_password("erin", "Passw0rd12", "NewPassw0rd23").unwrap();
    // 旧会话全部失效
    assert_eq!(svc.validate_session(&s1.raw_token).unwrap_err(), AuthError::InvalidToken);
    assert_eq!(svc.validate_session(&s2.raw_token).unwrap_err(), AuthError::InvalidToken);
    // 旧密码失效
    assert_eq!(svc.login("erin", "Passw0rd12").unwrap_err(), AuthError::InvalidCredentials);
    // 新密码可登录
    svc.login("erin", "NewPassw0rd23").unwrap();
}

#[test]
fn weak_password_rejected() {
    let (svc, _) = clocked(default_cfg());
    // (密码, 用户名前缀, 期望是否通过)
    let cases = [
        ("12345678", "digits_only", false), // 只有数字
        ("abcdefgh", "letters_only", false), // 只有字母
        ("short1", "too_short", false),      // 太短
        ("Passw0rd12", "valid", true),      // 合法
    ];
    for (pw, name, passes) in cases {
        let r = svc.register(name, pw, "U", UserRole::User);
        match (passes, r) {
            (true, Err(e)) => panic!("password {pw:?} should pass, got {e:?}"),
            (false, Ok(_)) => panic!("password {pw:?} should be rejected"),
            _ => {}
        }
    }
}

#[test]
fn disabled_user_cannot_login_or_validate() {
    let (svc, _) = clocked(default_cfg());
    svc.register("frank", "Passw0rd12", "Frank", UserRole::User).unwrap();
    let sess = svc.login("frank", "Passw0rd12").unwrap();
    svc.set_user_disabled("frank", true).unwrap();
    assert_eq!(svc.login("frank", "Passw0rd12").unwrap_err(), AuthError::UserDisabled);
    // 停用已吊销其全部存量会话，因此该 token 直接失效。
    assert_eq!(svc.validate_session(&sess.raw_token).unwrap_err(), AuthError::InvalidToken);
    // 启用后恢复
    svc.set_user_disabled("frank", false).unwrap();
    svc.login("frank", "Passw0rd12").unwrap();
}

#[test]
fn file_store_persists_users_and_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.json");

    let sess_raw = {
        let store: Arc<dyn UserStore> = Arc::new(FileStore::new(&path).unwrap());
        let svc = AuthService::new(store, default_cfg());
        svc.register("grace", "Passw0rd12", "Grace", UserRole::Admin).unwrap();
        let sess = svc.login("grace", "Passw0rd12").unwrap();
        assert!(path.exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        // 原始 token 与明文密码绝不出现在持久化文件里（只存 token 摘要）。
        assert!(!raw.contains(&sess.raw_token));
        assert!(!raw.contains("Passw0rd12"));
        sess.raw_token
    };

    // 重新加载：用户与会话一并持久化，未过期的会话可直接恢复（token 会话保持）。
    {
        let store2: Arc<dyn UserStore> = Arc::new(FileStore::new(&path).unwrap());
        let svc2 = AuthService::new(store2, default_cfg());
        let user = svc2.validate_session(&sess_raw).unwrap();
        assert_eq!(user.username, "grace");
        let s2 = svc2.login("grace", "Passw0rd12").unwrap();
        assert_eq!(s2.username, "grace");
    }
}

#[test]
fn file_store_reload_keeps_user_for_login() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.json");
    {
        let store: Arc<dyn UserStore> = Arc::new(FileStore::new(&path).unwrap());
        AuthService::new(store, default_cfg())
            .register("hank", "Passw0rd12", "Hank", UserRole::User)
            .unwrap();
    }
    let store: Arc<dyn UserStore> = Arc::new(FileStore::new(&path).unwrap());
    let svc = AuthService::new(store, default_cfg());
    svc.login("hank", "Passw0rd12").unwrap();
}