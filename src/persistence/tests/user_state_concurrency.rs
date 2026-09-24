use super::*;

#[tokio::test]
async fn older_playback_deletes_preserve_newer_checkpoints() {
    let path = unique_temp_db_path("out-of-order-playback-delete");
    let db = setup_test_playback_session_db(&path).await;
    let user_id = db
        .create_user(
            "delete-order@example.com".into(),
            "hash".into(),
            "Viewer".into(),
        )
        .await
        .unwrap();
    db.upsert_user_watch_progress(user_id, "movie:1".into(), 30.0, 300)
        .await
        .unwrap();
    db.upsert_user_continue_watching(
        user_id,
        json!({"sourceIdentity": "movie:1", "resumeSeconds": 30.0, "updatedAt": 300}),
    )
    .await
    .unwrap();
    // A completion DELETE still in flight during an exit flush may arrive
    // after a newer restart/seek PUT. Both progress tables must keep the PUT.
    db.delete_user_watch_progress(user_id, "movie:1".into(), 200)
        .await
        .unwrap();
    db.delete_user_continue_watching(user_id, "movie:1".into(), 200)
        .await
        .unwrap();
    assert_eq!(db.get_user_watch_progress(user_id).await.unwrap().len(), 1);
    assert_eq!(
        db.get_user_continue_watching(user_id).await.unwrap().len(),
        1
    );

    for (series_id, older_identity, newer_identity) in [
        ("show", "series:show:episode:0", "series:show:episode:1"),
        ("tmdb-tv-42", "tmdb:tv:42:s1:e1", "tmdb:tv:42:s1:e2"),
    ] {
        db.upsert_user_watch_progress(user_id, older_identity.into(), 10.0, 100)
            .await
            .unwrap();
        db.upsert_user_watch_progress(user_id, newer_identity.into(), 30.0, 300)
            .await
            .unwrap();
        db.upsert_user_continue_watching(
            user_id,
            json!({
                "sourceIdentity": newer_identity,
                "seriesId": series_id,
                "resumeSeconds": 30.0,
                "updatedAt": 300,
            }),
        )
        .await
        .unwrap();
        db.delete_user_watch_progress_for_series(user_id, series_id.into(), 200)
            .await
            .unwrap();
        db.delete_user_continue_watching_for_series(user_id, series_id.into(), 200)
            .await
            .unwrap();
        let progress = db.get_user_watch_progress(user_id).await.unwrap();
        assert!(!progress.iter().any(|entry| entry.0 == older_identity));
        assert!(
            progress
                .iter()
                .any(|entry| entry.0 == newer_identity && entry.2 == 300)
        );
        assert!(
            db.get_user_continue_watching(user_id)
                .await
                .unwrap()
                .iter()
                .any(|entry| {
                    entry["sourceIdentity"] == newer_identity && entry["updatedAt"] == 300
                })
        );
        // Older offline checkpoints remain tombstoned despite preserving the
        // newer episode. A truly newer series delete still removes it.
        db.upsert_user_watch_progress(user_id, older_identity.into(), 15.0, 150)
            .await
            .unwrap();
        assert!(
            !db.get_user_watch_progress(user_id)
                .await
                .unwrap()
                .iter()
                .any(|entry| entry.0 == older_identity)
        );
        db.delete_user_watch_progress_for_series(user_id, series_id.into(), 400)
            .await
            .unwrap();
        db.delete_user_continue_watching_for_series(user_id, series_id.into(), 400)
            .await
            .unwrap();
        assert!(
            !db.get_user_watch_progress(user_id)
                .await
                .unwrap()
                .iter()
                .any(|entry| entry.0 == newer_identity)
        );
        assert!(
            !db.get_user_continue_watching(user_id)
                .await
                .unwrap()
                .iter()
                .any(|entry| entry["sourceIdentity"] == newer_identity)
        );
    }
}

#[tokio::test]
async fn user_state_writes_wait_for_a_competing_writer_and_read_its_tombstones() {
    let path = unique_temp_db_path("user-state-writer-contention");
    let db = setup_test_playback_session_db(&path).await;
    let user_id = db
        .create_user("writer@example.com".into(), "hash".into(), "Writer".into())
        .await
        .unwrap();
    let other_user_id = db
        .create_user("other@example.com".into(), "hash".into(), "Other".into())
        .await
        .unwrap();
    let series_identity = "series:show:episode:0";
    for owner in [user_id, other_user_id] {
        db.upsert_user_watch_progress(owner, series_identity.into(), 10.0, 100)
            .await
            .unwrap();
        db.upsert_user_continue_watching(
            owner,
            json!({"sourceIdentity": series_identity, "seriesId": "show", "updatedAt": 100}),
        )
        .await
        .unwrap();
    }

    // An independent connection holds SQLite's writer lock. Deferred
    // read-then-write transactions fail immediately here instead of using
    // busy_timeout; write transactions must wait before reading tombstones.
    let blocker = open_connection(&db.users_path).unwrap();
    let blocker_tx =
        rusqlite::Transaction::new_unchecked(&blocker, rusqlite::TransactionBehavior::Immediate)
            .unwrap();
    let mut writes = tokio::task::JoinSet::new();
    let progress_db = db.clone();
    writes.spawn(async move {
        progress_db
            .upsert_user_watch_progress(user_id, "movie:deleted".into(), 20.0, 150)
            .await
    });
    let continue_db = db.clone();
    writes.spawn(async move {
        continue_db
            .upsert_user_continue_watching(
                user_id,
                json!({"sourceIdentity": "movie:deleted", "updatedAt": 150}),
            )
            .await
    });
    let progress_db = db.clone();
    writes.spawn(async move {
        progress_db
            .delete_user_watch_progress_for_series(user_id, "show".into(), 200)
            .await
    });
    let continue_db = db.clone();
    writes.spawn(async move {
        continue_db
            .delete_user_continue_watching_for_series(user_id, "show".into(), 200)
            .await
    });

    let early_result =
        tokio::time::timeout(std::time::Duration::from_millis(100), writes.join_next()).await;
    let waited_for_writer = early_result.is_err();
    for domain in [
        crate::persistence::user_state::WATCH_PROGRESS_DOMAIN,
        crate::persistence::user_state::CONTINUE_WATCHING_DOMAIN,
    ] {
        crate::persistence::user_state::record_tombstone(
            &blocker_tx,
            user_id,
            domain,
            "movie:deleted",
            200,
        )
        .unwrap();
    }
    blocker_tx.commit().unwrap();
    let mut results = Vec::new();
    if let Ok(Some(result)) = early_result {
        results.push(result);
    }
    while let Some(result) = writes.join_next().await {
        results.push(result);
    }
    for result in results {
        result
            .unwrap()
            .expect("a competing write must wait, not fail");
    }
    assert!(waited_for_writer, "writes must wait for the held lock");
    assert!(
        db.get_user_watch_progress(user_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        db.get_user_continue_watching(user_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.get_user_watch_progress(other_user_id).await.unwrap(),
        vec![(series_identity.to_owned(), 10.0, 100)]
    );
    assert_eq!(
        db.get_user_continue_watching(other_user_id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn concurrent_playback_checkpoints_keep_the_newest_progress_in_both_tables() {
    let path = unique_temp_db_path("concurrent-playback-checkpoints");
    let db = setup_test_playback_session_db(&path).await;
    let user_id = db
        .create_user(
            "checkpoint@example.com".into(),
            "hash".into(),
            "Checkpoint".into(),
        )
        .await
        .unwrap();
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(32));
    let mut writes = tokio::task::JoinSet::new();
    for updated_at in 1..=16 {
        let progress_db = db.clone();
        let progress_barrier = barrier.clone();
        writes.spawn(async move {
            progress_barrier.wait().await;
            progress_db
                .upsert_user_watch_progress(
                    user_id,
                    "movie:1".into(),
                    updated_at as f64,
                    updated_at,
                )
                .await
        });
        let continue_db = db.clone();
        let continue_barrier = barrier.clone();
        writes.spawn(async move {
            continue_barrier.wait().await;
            continue_db
                .upsert_user_continue_watching(
                    user_id,
                    json!({
                        "sourceIdentity": "movie:1",
                        "resumeSeconds": updated_at,
                        "updatedAt": updated_at,
                    }),
                )
                .await
        });
    }
    while let Some(result) = writes.join_next().await {
        result.unwrap().expect("concurrent checkpoint must save");
    }
    assert_eq!(
        db.get_user_watch_progress(user_id).await.unwrap(),
        vec![("movie:1".to_owned(), 16.0, 16)]
    );
    let entries = db.get_user_continue_watching(user_id).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["resumeSeconds"], 16.0);
    assert_eq!(entries[0]["updatedAt"], 16);
}
