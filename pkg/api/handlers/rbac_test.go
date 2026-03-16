package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/kubestellar/console/pkg/models"
	"github.com/kubestellar/console/pkg/test"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type rbacTestStore struct {
	test.MockStore
	users         map[uuid.UUID]*models.User
	listUsers     []models.User
	listUsersErr  error
	updateRoleErr error
	updatedUserID uuid.UUID
	updatedRole   string
}

func (s *rbacTestStore) GetUser(id uuid.UUID) (*models.User, error) {
	if s.users == nil {
		return nil, nil
	}
	return s.users[id], nil
}

func (s *rbacTestStore) ListUsers() ([]models.User, error) {
	if s.listUsersErr != nil {
		return nil, s.listUsersErr
	}
	return s.listUsers, nil
}

func (s *rbacTestStore) UpdateUserRole(userID uuid.UUID, role string) error {
	s.updatedUserID = userID
	s.updatedRole = role
	return s.updateRoleErr
}

func TestRBACUpdateUserRole_ForbiddenForNonAdmin(t *testing.T) {
	env := setupTestEnv(t)
	adminUser := &models.User{
		ID:   testAdminUserID,
		Role: string(models.UserRoleViewer),
	}

	store := &rbacTestStore{
		users: map[uuid.UUID]*models.User{
			testAdminUserID: adminUser,
		},
	}

	handler := NewRBACHandler(store, nil)
	env.App.Put("/api/rbac/users/:id/role", handler.UpdateUserRole)

	body, err := json.Marshal(map[string]any{"role": string(models.UserRoleEditor)})
	require.NoError(t, err)

	req, err := http.NewRequest(http.MethodPut, "/api/rbac/users/"+uuid.NewString()+"/role", bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	resp, err := env.App.Test(req, 5000)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestRBACUpdateUserRole_Success(t *testing.T) {
	env := setupTestEnv(t)
	targetUserID := uuid.New()
	adminUser := &models.User{
		ID:   testAdminUserID,
		Role: string(models.UserRoleAdmin),
	}

	store := &rbacTestStore{
		users: map[uuid.UUID]*models.User{
			testAdminUserID: adminUser,
		},
	}

	handler := NewRBACHandler(store, nil)
	env.App.Put("/api/rbac/users/:id/role", handler.UpdateUserRole)

	body, err := json.Marshal(map[string]any{"role": string(models.UserRoleEditor)})
	require.NoError(t, err)

	req, err := http.NewRequest(http.MethodPut, "/api/rbac/users/"+targetUserID.String()+"/role", bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	resp, err := env.App.Test(req, 5000)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, targetUserID, store.updatedUserID)
	assert.Equal(t, string(models.UserRoleEditor), store.updatedRole)
}

func TestRBACListConsoleUsers_Success(t *testing.T) {
	env := setupTestEnv(t)
	adminUser := &models.User{
		ID:   testAdminUserID,
		Role: string(models.UserRoleAdmin),
	}

	store := &rbacTestStore{
		users: map[uuid.UUID]*models.User{
			testAdminUserID: adminUser,
		},
		listUsers: []models.User{
			{ID: testAdminUserID, GitHubLogin: "admin", Role: string(models.UserRoleAdmin)},
			{ID: uuid.New(), GitHubLogin: "dev1", Role: string(models.UserRoleEditor)},
		},
	}

	handler := NewRBACHandler(store, nil)
	env.App.Get("/api/rbac/users", handler.ListConsoleUsers)

	req, err := http.NewRequest(http.MethodGet, "/api/rbac/users", nil)
	require.NoError(t, err)

	resp, err := env.App.Test(req, 5000)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var users []models.User
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&users))
	assert.Len(t, users, 2)
	assert.Equal(t, "admin", users[0].GitHubLogin)
}
